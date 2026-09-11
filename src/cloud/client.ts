import type { Checkpoint } from "./checkpoints.ts";

export type WorkerIdentity = {
  controllerUrl: string;
  streamId: string;
  generation: number;
  token: string;
};

export class CloudClient {
  private readonly base: string;
  private readonly identity: WorkerIdentity;

  constructor(identity: WorkerIdentity) {
    const url = new URL(identity.controllerUrl);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error(
        "Controller URL must be an HTTPS origin (HTTP loopback is allowed for tests)",
      );
    }
    if (
      !identity.streamId ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 1 ||
      !identity.token
    ) {
      throw new Error("Complete worker identity required");
    }
    this.identity = identity;
    this.base = `${url.origin}/internal/cloud/${encodeURIComponent(identity.streamId)}/${identity.generation}/`;
  }

  async request<T>(operation: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${operation}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.identity.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(operation === "checkpoint" ? 120_000 : 30_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(
        `Cloud ${operation} failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
      );
    }
    return (await response.json()) as T;
  }

  async query(sql?: string, mode?: string): Promise<Array<Record<string, unknown>>> {
    return (await this.request<{ rows: Array<Record<string, unknown>> }>("query", { sql, mode }))
      .rows;
  }

  async checkpoint(checkpoint: Checkpoint): Promise<void> {
    const response = await this.request<{ version: number }>("checkpoint", checkpoint);
    if (response.version !== checkpoint.version)
      throw new Error("Checkpoint acknowledgement version mismatch");
  }
}
