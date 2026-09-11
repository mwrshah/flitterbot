import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Checkpoint } from "./checkpoints.ts";

export class CheckpointPublisher {
  private readonly directory: string;
  private readonly send: (checkpoint: Checkpoint) => Promise<void>;
  private readonly report: (error: unknown) => void;
  private tail: Promise<void> = Promise.resolve();
  private retry?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    directory: string,
    send: (checkpoint: Checkpoint) => Promise<void>,
    report: (error: unknown) => void,
  ) {
    this.directory = directory;
    this.send = send;
    this.report = report;
  }

  async stage(checkpoint: Checkpoint): Promise<void> {
    if (this.stopped) throw new Error("Checkpoint publisher is stopped");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${checkpoint.version}.json`);
    const bytes = JSON.stringify(checkpoint);
    const temporary = `${filename}.${crypto.randomUUID()}.incoming`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.readFile(filename, "utf8")) !== bytes)
        throw new Error("Checkpoint version already staged with different content");
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const directory = await fs.open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    void this.flush().catch(this.report);
  }

  flush(): Promise<void> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.stopped) return;
        let names: string[];
        try {
          names = await fs.readdir(this.directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        const versions = names
          .filter((name) => /^[1-9][0-9]*\.json$/.test(name))
          .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
        for (const name of versions) {
          const filename = path.join(this.directory, name);
          const checkpoint = JSON.parse(await fs.readFile(filename, "utf8")) as Checkpoint;
          await this.send(checkpoint);
          await fs.unlink(filename);
        }
      });
    this.tail = operation;
    void operation.catch(() => {
      if (this.stopped || this.retry) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.flush().catch(this.report);
      }, 5_000);
      this.retry.unref();
    });
    return operation;
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }
}
