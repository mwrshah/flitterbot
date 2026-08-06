import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AuthFlowPrompt,
  AuthFlowSnapshot,
  AuthProvider,
  AuthProvidersResponse,
} from "../contracts/index.ts";

const FLOW_RETENTION_MS = 10 * 60 * 1000;

type PendingPrompt = {
  prompt: AuthFlowPrompt;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
};

type AuthFlow = {
  id: string;
  status: AuthFlowSnapshot["status"];
  providerId: string;
  events: AuthEvent[];
  controller: AbortController;
  prompt?: PendingPrompt;
  error?: string;
  cleanupTimer?: NodeJS.Timeout;
};

export class ProviderAuthManager {
  private readonly getRuntime: () => Promise<ModelRuntime>;
  private readonly flows = new Map<string, AuthFlow>();
  private readonly loginStarts = new Map<string, Promise<AuthFlowSnapshot>>();
  private stopped = false;

  constructor(getRuntime: () => Promise<ModelRuntime>) {
    this.getRuntime = getRuntime;
  }

  async listProviders(): Promise<AuthProvidersResponse> {
    const runtime = await this.createRuntime();
    const connectedProviders = new Set(
      (await runtime.listCredentials()).map((credential) => credential.providerId),
    );
    const providers: AuthProvider[] = runtime
      .getProviders()
      .flatMap((provider) => {
        const oauth = provider.auth.oauth;
        if (!oauth) return [];
        return [
          {
            id: provider.id,
            name: provider.name,
            oauthName: oauth.name,
            ...(oauth.loginLabel ? { loginLabel: oauth.loginLabel } : {}),
            searchText: [
              provider.id,
              provider.name,
              oauth.name,
              oauth.loginLabel ?? "",
              ...provider.getModels().flatMap((model) => [model.id, model.name]),
            ]
              .join("\n")
              .toLowerCase(),
            connected: connectedProviders.has(provider.id),
          },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { providers };
  }

  startLogin(providerId: string): Promise<AuthFlowSnapshot> {
    if (this.stopped) return Promise.reject(new Error("Provider authentication is stopped"));
    const existing = [...this.flows.values()].find(
      (flow) => flow.providerId === providerId && flow.status === "running",
    );
    if (existing) return Promise.resolve(this.snapshot(existing));

    const pending = this.loginStarts.get(providerId);
    if (pending) return pending;

    const started = this.createLogin(providerId);
    const tracked = started.finally(() => {
      if (this.loginStarts.get(providerId) === tracked) this.loginStarts.delete(providerId);
    });
    this.loginStarts.set(providerId, tracked);
    return tracked;
  }

  private async createLogin(providerId: string): Promise<AuthFlowSnapshot> {
    const runtime = await this.createRuntime();
    if (this.stopped) throw new Error("Provider authentication is stopped");
    const provider = runtime.getProvider(providerId);
    if (!provider?.auth.oauth) {
      throw new Error(`Provider "${providerId}" does not support OAuth login`);
    }

    const flow: AuthFlow = {
      id: crypto.randomUUID(),
      status: "running",
      providerId,
      events: [],
      controller: new AbortController(),
    };
    this.flows.set(flow.id, flow);
    flow.cleanupTimer = setTimeout(() => this.cancel(flow.id), FLOW_RETENTION_MS);
    flow.cleanupTimer.unref();
    void this.runLogin(runtime, flow);
    return this.snapshot(flow);
  }

  getFlow(flowId: string): AuthFlowSnapshot | undefined {
    const flow = this.flows.get(flowId);
    return flow ? this.snapshot(flow) : undefined;
  }

  respond(flowId: string, promptId: string, value: string): AuthFlowSnapshot {
    const flow = this.requireFlow(flowId);
    const pending = flow.prompt;
    if (flow.status !== "running" || !pending || pending.prompt.id !== promptId) {
      throw new Error("Authentication prompt is no longer active");
    }
    if (
      pending.prompt.type === "select" &&
      !pending.prompt.options?.some((option) => option.id === value)
    ) {
      throw new Error("Authentication selection is not valid");
    }
    flow.prompt = undefined;
    pending.removeAbortListener?.();
    pending.resolve(value);
    return this.snapshot(flow);
  }

  cancel(flowId: string): AuthFlowSnapshot {
    const flow = this.requireFlow(flowId);
    if (flow.status === "running") {
      flow.status = "cancelled";
      flow.controller.abort();
      this.rejectPrompt(flow, new Error("Login cancelled"));
      this.scheduleCleanup(flow);
    }
    return this.snapshot(flow);
  }

  async logout(providerId: string): Promise<void> {
    for (const flow of this.flows.values()) {
      if (flow.providerId === providerId && flow.status === "running") this.cancel(flow.id);
    }
    const runtime = await this.createRuntime();
    if (!runtime.getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);
    await runtime.logout(providerId);
  }

  stop(): void {
    this.stopped = true;
    this.loginStarts.clear();
    for (const flow of this.flows.values()) {
      if (flow.status === "running") this.cancel(flow.id);
      if (flow.cleanupTimer) clearTimeout(flow.cleanupTimer);
    }
    this.flows.clear();
  }

  private createRuntime(): Promise<ModelRuntime> {
    return this.getRuntime();
  }

  private async runLogin(runtime: ModelRuntime, flow: AuthFlow): Promise<void> {
    try {
      await runtime.login(flow.providerId, "oauth", {
        signal: flow.controller.signal,
        notify: (event) => {
          if (flow.status !== "running") return;
          flow.events = [...flow.events.slice(-19), event];
        },
        prompt: (prompt) => this.waitForPrompt(flow, prompt),
      });
      if (flow.status === "running") flow.status = "succeeded";
    } catch (error) {
      if (flow.status !== "cancelled") {
        flow.status = "failed";
        flow.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.rejectPrompt(flow, new Error("Authentication flow ended"));
      this.scheduleCleanup(flow);
    }
  }

  private waitForPrompt(flow: AuthFlow, prompt: AuthPrompt): Promise<string> {
    if (flow.status !== "running" || flow.controller.signal.aborted || prompt.signal?.aborted) {
      return Promise.reject(new Error("Login cancelled"));
    }
    this.rejectPrompt(flow, new Error("Authentication prompt was replaced"));
    return new Promise<string>((resolve, reject) => {
      const { signal: _signal, ...transportPrompt } = prompt;
      const pending: PendingPrompt = {
        prompt: {
          id: crypto.randomUUID(),
          ...transportPrompt,
        },
        resolve,
        reject,
      };
      if (prompt.signal) {
        const abort = () => {
          if (flow.prompt !== pending) return;
          flow.prompt = undefined;
          reject(new Error("Authentication prompt was cancelled"));
        };
        prompt.signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => prompt.signal?.removeEventListener("abort", abort);
      }
      flow.prompt = pending;
    });
  }

  private rejectPrompt(flow: AuthFlow, error: Error): void {
    const pending = flow.prompt;
    if (!pending) return;
    flow.prompt = undefined;
    pending.removeAbortListener?.();
    pending.reject(error);
  }

  private requireFlow(flowId: string): AuthFlow {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error("Authentication flow not found");
    return flow;
  }

  private snapshot(flow: AuthFlow): AuthFlowSnapshot {
    return {
      id: flow.id,
      status: flow.status,
      providerId: flow.providerId,
      events: [...flow.events],
      ...(flow.prompt ? { prompt: flow.prompt.prompt } : {}),
      ...(flow.error ? { error: flow.error } : {}),
    };
  }

  private scheduleCleanup(flow: AuthFlow): void {
    if (flow.cleanupTimer) clearTimeout(flow.cleanupTimer);
    flow.cleanupTimer = setTimeout(() => this.flows.delete(flow.id), FLOW_RETENTION_MS);
    flow.cleanupTimer.unref();
  }
}
