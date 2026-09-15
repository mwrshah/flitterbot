import fs from "node:fs";
import path from "node:path";
import type { ClaudeHookPayload } from "../contracts/index.ts";
import { killTmuxSession } from "../tmux-sessions/tmux.ts";
import type { CloudClient } from "./client.ts";
import { DurableOutbox } from "./publisher.ts";
import type { WorkerBootstrap } from "./worker-agent.ts";

type HookRecord = { version: number; event: string; payload: ClaudeHookPayload; content?: string };

export class WorkerHooks {
  private readonly file: string;
  private readonly bootstrap: WorkerBootstrap;
  private readonly outbox: DurableOutbox<HookRecord>;
  private state: {
    version: number;
    sessions: Record<string, { payload: ClaudeHookPayload; transcript?: string }>;
  };
  private staging: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(client: CloudClient, bootstrap: WorkerBootstrap, report: (error: unknown) => void) {
    this.bootstrap = bootstrap;
    this.file = path.join(path.dirname(bootstrap.outbox), "downstreams.json");
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { version: 0, sessions: {} };
    this.outbox = new DurableOutbox<HookRecord>(
      path.join(path.dirname(bootstrap.outbox), "hooks"),
      async (record) => {
        await client.request("hook", record);
      },
      report,
    );
    void this.outbox.flush().catch(report);
  }

  async accept(event: string, input: ClaudeHookPayload): Promise<void> {
    if (!["session-start", "stop", "session-end", "snapshot"].includes(event))
      throw new Error("Unknown hook event");
    const payload = input as Record<string, unknown>;
    const sessionId = String(payload.session_id ?? payload.sessionId ?? "");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))
      throw new Error("Valid downstream session ID required");
    if (this.closing && event === "session-start") throw new Error("Stream is closing");
    const record: HookRecord = {
      version: ++this.state.version,
      event,
      payload: {
        ...input,
        session_id: sessionId,
        stream_id: this.bootstrap.streamId,
        pi_session_id: this.bootstrap.piSessionId,
        agent_managed: true,
      },
    };
    const transcript =
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : typeof payload.transcriptPath === "string"
          ? payload.transcriptPath
          : this.state.sessions[sessionId]?.transcript;
    if (transcript && !path.isAbsolute(transcript))
      throw new Error("Absolute transcript path required");
    if (transcript && fs.existsSync(transcript)) {
      if (fs.statSync(transcript).size > 128 * 1024 * 1024)
        throw new Error("Downstream transcript exceeds 128 MiB");
      record.content = fs.readFileSync(transcript, "utf8");
    }
    this.state.sessions[sessionId] = { payload: record.payload, transcript };
    const temporary = `${this.file}.tmp`;
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(this.state));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(path.dirname(this.file), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    const operation = this.staging.catch(() => {}).then(() => this.outbox.stage(record));
    this.staging = operation;
    await operation;
  }

  transcript(sessionId: string): string | undefined {
    return this.state.sessions[sessionId]?.transcript;
  }

  async settle(): Promise<void> {
    const names = new Set(
      Object.values(this.state.sessions)
        .map(({ payload }) => payload.tmux_session)
        .filter((name): name is string => typeof name === "string" && Boolean(name)),
    );
    for (const name of names) await killTmuxSession(name);
  }

  async publish(final = false): Promise<void> {
    if (final) {
      this.closing = true;
      await this.settle();
    }
    for (const entry of Object.values(this.state.sessions))
      await this.accept(final ? "session-end" : "snapshot", entry.payload);
    await this.staging;
    await this.outbox.flush();
  }

  stop(): void {
    this.outbox.stop();
  }
}
