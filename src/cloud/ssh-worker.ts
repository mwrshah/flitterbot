import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkerAssignment, WorkerLifecycle } from "./coordinator.ts";
import type { WorkerBootstrap } from "./worker-agent.ts";

type BootstrapInput = {
  bootstrap: WorkerBootstrap;
  sourceRoot: string;
  sourceCwd: string;
  sessionContent: string;
  checkpointDirectory?: string;
};

export const WORKER_BOOTSTRAP_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
let text = '';
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', async () => {
  const {bootstrap, sourceRoot, sourceCwd, checkpointDirectory} = JSON.parse(text);
  let {sessionContent} = JSON.parse(text);
  const directory = path.dirname(bootstrap.outbox);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const configPath = path.join(directory, 'bootstrap.json');
  const pidPath = path.join(directory, 'worker.pid');
  if (fs.existsSync(pidPath)) {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
        if (command.includes(configPath)) { process.stdout.write('already started'); return; }
      } catch {}
    }
  }
  if (fs.existsSync(configPath)) {
    bootstrap.cwd = JSON.parse(fs.readFileSync(configPath, 'utf8')).cwd;
  } else if (checkpointDirectory && fs.existsSync(path.join(checkpointDirectory, 'repository.bundle'))) {
    const workspace = path.join(directory, 'workspace');
    const marker = path.join(directory, 'workspace-restored');
    if (!fs.existsSync(marker)) {
      fs.rmSync(workspace, {recursive: true, force: true});
      const {restoreRepository} = await import(require('node:url').pathToFileURL(path.join(sourceRoot, 'src/cloud/repository.ts')).href);
      await restoreRepository(checkpointDirectory, workspace);
      const {hydrateWorkspace} = await import(require('node:url').pathToFileURL(path.join(sourceRoot, 'src/cloud/workspace.ts')).href);
      await hydrateWorkspace(bootstrap.start?.root || sourceCwd, workspace);
      fs.writeFileSync(marker, 'restored', {mode: 0o600});
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(checkpointDirectory, 'manifest.json'), 'utf8'));
    bootstrap.cwd = path.join(workspace, manifest.workspace.cwdRelative || '');
    fs.mkdirSync(bootstrap.cwd, {recursive: true});
    bootstrap.baseRef = manifest.workspace.baseRef || bootstrap.baseRef;
  } else if (bootstrap.start) {
    const marker = path.join(directory, 'workspace-initialized');
    if (fs.existsSync(marker)) bootstrap.cwd = fs.readFileSync(marker, 'utf8');
    else {
      if (bootstrap.start.mode !== 'workspace') fs.rmSync(path.join(directory, 'workspace'), {recursive: true, force: true});
      const {initializeWorkspace} = await import(require('node:url').pathToFileURL(path.join(sourceRoot, 'src/cloud/workspace.ts')).href);
      bootstrap.cwd = await initializeWorkspace(bootstrap.start, directory, bootstrap.streamId);
      fs.writeFileSync(marker, bootstrap.cwd, {mode: 0o600});
    }
  }
  if (!fs.existsSync(configPath) || !fs.existsSync(bootstrap.sessionFile)) {
    const lines = sessionContent.split('\n');
    const header = JSON.parse(lines[0]);
    header.cwd = bootstrap.cwd;
    lines[0] = JSON.stringify(header);
    sessionContent = lines.join('\n');
    fs.mkdirSync(path.dirname(bootstrap.sessionFile), {recursive: true});
    fs.writeFileSync(bootstrap.sessionFile, sessionContent, {mode: 0o600});
  }
  if (fs.existsSync(configPath)) {
    bootstrap.baseRef = JSON.parse(fs.readFileSync(configPath, 'utf8')).baseRef;
  } else {
    try { bootstrap.baseRef = cp.execFileSync('git', ['rev-parse', bootstrap.baseRef || 'HEAD'], {cwd: bootstrap.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch {}
  }
  fs.writeFileSync(configPath, JSON.stringify(bootstrap), {mode: 0o600});
  const settingsPath = path.join(require('node:os').homedir(), '.flitterbot/config.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  Object.assign(settings, {controlSurfaceHost: '127.0.0.1', controlSurfacePort: 3002, controlSurfaceToken: bootstrap.token, whatsappEnabled: false, wipeStreamsOnStart: false});
  fs.writeFileSync(settingsPath, JSON.stringify(settings), {mode: 0o600});
  const log = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
  const child = cp.spawn('flock', ['-n', '/tmp/flitterbot-worker-writer.lock', process.execPath, path.join(sourceRoot, 'src/cloud/worker-server.ts'), configPath, '3002'], {
    cwd: sourceRoot, detached: true, stdio: ['ignore', log, log]
  });
  fs.writeFileSync(pidPath, String(child.pid), {mode: 0o600});
  child.unref();
  process.stdout.write('started');
});
`;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sshArgs(name: string): string[] {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Invalid worker VM name");
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "HostKeyAlias=exe.dev",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    `${name}.exe.xyz`,
  ];
}

async function remote(name: string, command: string, input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(name), command], { stdio: ["pipe", "ignore", "pipe"] });
    let detail = "";
    child.stderr.on("data", (chunk) => {
      detail = (detail + chunk.toString()).slice(-2000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Worker bootstrap SSH timed out"));
    }, 600_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Worker bootstrap failed: ${detail}`));
    });
  });
}

export class SshWorkerLifecycle implements WorkerLifecycle {
  private readonly bootstrap: (assignment: WorkerAssignment) => Promise<BootstrapInput>;
  private readonly controllerPort: number;
  private readonly tunnels = new Map<string, Promise<{ origin: string; child: ChildProcess }>>();

  constructor(
    bootstrap: (assignment: WorkerAssignment) => Promise<BootstrapInput>,
    controllerPort: number,
  ) {
    this.bootstrap = bootstrap;
    this.controllerPort = controllerPort;
  }

  async boot(assignment: WorkerAssignment): Promise<void> {
    const input = await this.bootstrap(assignment);
    await this.origin(assignment);
    await remote(
      assignment.worker.vm_name,
      `flock -n /tmp/flitterbot-worker-bootstrap.lock node -e ${quote(WORKER_BOOTSTRAP_SCRIPT)}`,
      JSON.stringify(input),
    );
  }

  async origin(assignment: WorkerAssignment): Promise<string> {
    const name = assignment.worker.vm_name;
    let pending = this.tunnels.get(name);
    if (!pending) {
      pending = this.openTunnel(name);
      this.tunnels.set(name, pending);
      void pending.catch(() => {
        if (this.tunnels.get(name) === pending) this.tunnels.delete(name);
      });
    }
    return (await pending).origin;
  }

  private async openTunnel(name: string): Promise<{ origin: string; child: ChildProcess }> {
    const reservation = net.createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === "string")
      throw new Error("Cannot allocate SSH forwarding port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const args = sshArgs(name);
    const destination = args.pop()!;
    const child = spawn(
      "ssh",
      [
        ...args,
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        `127.0.0.1:${port}:127.0.0.1:3002`,
        "-R",
        `127.0.0.1:3003:127.0.0.1:${this.controllerPort}`,
        destination,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let failure: Error | undefined;
    let detail = "";
    child.stderr?.on("data", (chunk) => {
      detail = (detail + chunk.toString()).slice(-2000);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("exit", () => {
      failure = new Error(`SSH tunnel closed: ${detail}`);
      this.tunnels.delete(name);
    });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const connected = await new Promise<boolean>((resolve) => {
          const socket = net.createConnection({ host: "127.0.0.1", port });
          socket.setTimeout(500);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => {
            socket.destroy();
            resolve(false);
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (connected) return { origin: `http://127.0.0.1:${port}`, child };
        await delay(100);
      }
      throw new Error("SSH forwarding did not become ready");
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async request(assignment: WorkerAssignment, pathname: string, body?: unknown): Promise<Response> {
    return fetch(`${await this.origin(assignment)}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${assignment.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(
        pathname === "/worker/health" || pathname === "/worker/wake" ? 5_000 : 180_000,
      ),
    });
  }

  async ready(assignment: WorkerAssignment): Promise<boolean> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await this.request(assignment, "/worker/health");
        const body = (await response.json()) as { streamId?: string; generation?: number };
        if (
          response.ok &&
          body.streamId === assignment.worker.stream_id &&
          body.generation === assignment.worker.generation
        )
          return true;
        if (response.status === 401) return false;
      } catch {}
      await delay(250);
    }
    return false;
  }

  async finalCheckpoint(assignment: WorkerAssignment): Promise<number> {
    const response = await this.request(assignment, "/worker/checkpoint", { final: true });
    if (!response.ok) throw new Error(`Worker final checkpoint failed (${response.status})`);
    const body = (await response.json()) as { version: number };
    return body.version;
  }

  async dispose(): Promise<void> {
    for (const pending of this.tunnels.values()) {
      await pending.then(
        ({ child }) => child.kill(),
        () => {},
      );
    }
    this.tunnels.clear();
  }
}
