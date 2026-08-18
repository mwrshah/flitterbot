import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AuthFlowSnapshot,
  AuthProvidersResponse,
  DirectoryCompletionsResponse,
  DirectSessionMessageResponse,
  DownstreamSessionItem,
  ModelsListResponse,
  ModelsMutationResponse,
  RemoveTurnQueueItemResponse,
  SessionDetailResponse,
  SessionSearchResponse,
  SessionsListResponse,
  SkillsListResponse,
  StatusResponse,
  StreamsHistoryLimit,
  StreamsHistoryResponse,
  TranscriptPageResponse,
} from "./types";

export type StreamInfo = {
  streamId: string | null;
  name: string | null;
  repoPath: string | null;
  repo: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  cwd: string | null;
  cwdAbsolute: string | null;
  copyPaths: string[];
  postCreate: string[];
  configuredBaseRef: string | null;
};

export type DiffResult =
  | { mode: "diff"; diff: string }
  | { mode: "summary"; stat: string; files: number; insertions: number; deletions: number };

export type ControlSurfaceSettings = {
  baseUrl: string;
  token: string;
  useStubFallback: boolean;
};

export type FlitterbotApiClient = ReturnType<typeof createFlitterbotApiClient>;

export function createFlitterbotApiClient(getSettings: () => ControlSurfaceSettings) {
  async function request<T>(path: string, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
    const { baseUrl, token } = getSettings();
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    };

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(url, { ...init, headers, signal });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.clone().json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error) message = body.error;
      } catch {}
      throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  return {
    getStatus: () => request<StatusResponse>("/status"),

    listSessions: () => request<SessionsListResponse>("/api/sessions"),

    getSessionDetail: (sessionId: string) =>
      request<SessionDetailResponse>(`/api/sessions/${sessionId}`),

    searchSessions: (query: string) =>
      request<SessionSearchResponse>(`/api/session-search?${new URLSearchParams({ query })}`),

    getTranscript: (sessionId: string, cursor?: string, limit = 25) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      return request<TranscriptPageResponse>(`/api/sessions/${sessionId}/transcript?${params}`);
    },

    sendDirectSessionMessage: (sessionId: string, text: string) =>
      request<DirectSessionMessageResponse>(`/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),

    startWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/start", { method: "POST" }),

    stopWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/stop", { method: "POST" }),

    interruptPiSession: (piSessionId: string) =>
      request<{ ok: boolean }>(`/api/pi-sessions/${piSessionId}/interrupt`, {
        method: "POST",
      }),

    removeTurnQueueItem: (piSessionId: string, itemId: string) =>
      request<RemoveTurnQueueItemResponse>(
        `/api/pi-sessions/${encodeURIComponent(piSessionId)}/turn-queue/${encodeURIComponent(itemId)}`,
        { method: "DELETE" },
      ),

    reopenStream: (streamId: string) =>
      request<{ ok: boolean }>(`/api/streams/${streamId}/reopen`, { method: "POST" }),

    closeSwimlane: (streamId: string) =>
      request<{ ok: true; streamId: string; message: string }>(`/api/streams/${streamId}/close`, {
        method: "POST",
      }),

    setStreamPinned: (streamId: string, pinned: boolean) =>
      request<{ ok: true; streamId: string; pinned: boolean }>(`/api/streams/${streamId}/pin`, {
        method: "PUT",
        body: JSON.stringify({ pinned }),
      }),

    setStreamName: (streamId: string, name: string) =>
      request<{ ok: true; streamId: string; name: string }>(`/api/streams/${streamId}/name`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      }),

    createSwimlane: (body?: { name?: string; cwd?: string }) =>
      request<{ ok: true; streamId: string; streamName: string; piSessionId: string }>(
        "/api/streams",
        {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        },
      ),

    pruneStreamHistory: (piSessionId: string, entryId: string) =>
      request<{ ok: true; piSessionId: string; messageCount: number }>("/api/streams/prune", {
        method: "POST",
        body: JSON.stringify({ piSessionId, entryId }),
      }),

    forkStream: (piSessionId: string, entryId?: string) =>
      request<{ ok: true; streamId: string; streamName: string; piSessionId: string }>(
        "/api/streams/fork",
        {
          method: "POST",
          body: JSON.stringify({ piSessionId, ...(entryId ? { entryId } : {}) }),
        },
      ),

    compactPiSession: (piSessionId: string, customInstructions?: string) =>
      request<{
        ok: true;
        piSessionId: string;
        messageCount: number;
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
      }>("/api/streams/compact", {
        method: "POST",
        body: JSON.stringify({ piSessionId, customInstructions }),
      }),

    listSkills: () => request<SkillsListResponse>("/api/skills"),

    listModels: (signal?: AbortSignal) => request<ModelsListResponse>("/api/models", { signal }),

    pinModel: (id: string, pin: boolean, label?: string) =>
      request<ModelsMutationResponse>("/api/models/pin", {
        method: "POST",
        body: JSON.stringify({ id, pin, ...(label ? { label } : {}) }),
      }),

    setPiSessionModel: (piSessionId: string, id: string) =>
      request<ModelsMutationResponse>(`/api/pi-sessions/${piSessionId}/model`, {
        method: "PUT",
        body: JSON.stringify({ id }),
      }),

    setPiSessionThinkingLevel: (piSessionId: string, level: ModelThinkingLevel) =>
      request<ModelsMutationResponse>(`/api/pi-sessions/${piSessionId}/thinking-level`, {
        method: "PUT",
        body: JSON.stringify({ level }),
      }),

    getStreamsHistory: (
      input: {
        piSessionId?: string;
        surface?: "input" | "agent";
        before?: string;
        limit?: StreamsHistoryLimit;
      },
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams();
      if (input.piSessionId) params.set("piSessionId", input.piSessionId);
      if (input.surface) params.set("surface", input.surface);
      if (input.before) params.set("before", input.before);
      if (input.limit) params.set("limit", String(input.limit));
      const query = params.toString();
      return request<StreamsHistoryResponse>(
        `/api/streams/history${query ? `?${query}` : ""}`,
        { signal },
        input.limit === "all" ? 30_000 : 8_000,
      );
    },

    getDownstreamSessions: async (piSessionId: string, signal?: AbortSignal) => {
      const response = await request<{ items: DownstreamSessionItem[] }>(
        `/api/pi-sessions/${encodeURIComponent(piSessionId)}/sessions`,
        { signal },
      );
      return response.items;
    },

    setStreamCwd: (streamId: string, cwd: string) =>
      request<{ ok: true; streamId: string; cwd: string; piSessionId: string }>(
        `/api/streams/${encodeURIComponent(streamId)}/cwd`,
        { method: "POST", body: JSON.stringify({ cwd }) },
      ),

    getStream: (piSessionId: string, signal?: AbortSignal) =>
      request<StreamInfo>(`/api/pi-sessions/${encodeURIComponent(piSessionId)}/stream`, { signal }),

    getStreamDiff: (piSessionId: string, signal?: AbortSignal) =>
      request<DiffResult | undefined>(
        `/api/pi-sessions/${encodeURIComponent(piSessionId)}/diff`,
        { signal },
        15_000,
      ),

    getDirectoryCompletions: async (
      input: {
        query: string;
        piSessionId?: string;
        streamId?: string;
        directoriesOnly?: boolean;
      },
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams({ query: input.query });
      if (input.piSessionId) params.set("piSessionId", input.piSessionId);
      if (input.streamId) params.set("streamId", input.streamId);
      if (input.directoriesOnly) params.set("directoriesOnly", "true");
      try {
        return await request<DirectoryCompletionsResponse>(`/api/directory-completions?${params}`, {
          signal,
        });
      } catch {
        return { items: [], cwd: "", query: input.query };
      }
    },

    listAuthProviders: () => request<AuthProvidersResponse>("/api/auth/providers"),

    startAuthLogin: (providerId: string) =>
      request<AuthFlowSnapshot>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ providerId }),
      }),

    getAuthFlow: (flowId: string) =>
      request<AuthFlowSnapshot>(`/api/auth/flows/${encodeURIComponent(flowId)}`),

    respondAuthFlow: (flowId: string, promptId: string, value: string) =>
      request<AuthFlowSnapshot>(`/api/auth/flows/${encodeURIComponent(flowId)}/respond`, {
        method: "POST",
        body: JSON.stringify({ promptId, value }),
      }),

    cancelAuthFlow: (flowId: string) =>
      request<AuthFlowSnapshot>(`/api/auth/flows/${encodeURIComponent(flowId)}`, {
        method: "DELETE",
      }),

    logoutAuthProvider: (providerId: string) =>
      request<{ ok: true }>(`/api/auth/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      }),

    getUserConfig: (userId: string) =>
      request<{ config: Record<string, string> }>(`/api/user-config/${userId}`),

    setUserConfig: (userId: string, config: Record<string, string>) =>
      request<{ ok: boolean }>(`/api/user-config/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ config }),
      }),
  };
}
