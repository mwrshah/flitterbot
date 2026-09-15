import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hostname = os.hostname();
if (process.platform !== "linux" || !/^[a-z0-9][a-z0-9-]*$/.test(hostname)) throw new Error("Run on the exe.dev controller VM");
const home = os.homedir();
const config = JSON.parse(fs.readFileSync(path.join(home, ".flitterbot/config.json"), "utf8"));
if (!config.controlSurfaceToken || !config.controlSurfacePort) throw new Error("Configure Flitterbot first");
execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "exe.dev", "whoami", "--json"], { stdio: "pipe" });
const built = { ...process.env, VITE_FLITTERBOT_BASE_URL: `https://${hostname}.exe.xyz`, VITE_FLITTERBOT_TOKEN: config.controlSurfaceToken };
execFileSync("pnpm", ["--dir", "web", "run", "build"], { cwd: root, env: built, stdio: "inherit" });
const envFile = path.join(home, ".flitterbot/cloud-web.env");
fs.writeFileSync(envFile, `VITE_FLITTERBOT_BASE_URL=http://127.0.0.1:${config.controlSurfacePort}\nVITE_FLITTERBOT_TOKEN=${config.controlSurfaceToken}\n`, { mode: 0o600 });
fs.chmodSync(envFile, 0o600);
const units = {
  "flitterbot-cloud-controller": `${process.execPath} ${root}src/server.ts --cloud`,
  "flitterbot-cloud-web": `${process.execPath} ${root}web/node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port 8000`,
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-services-"));
try {
  for (const [name, command] of Object.entries(units)) {
    const workingDirectory = name.endsWith("-web") ? path.join(root, "web") : root;
    const file = path.join(temporary, `${name}.service`);
    fs.writeFileSync(file, `[Unit]\nDescription=${name}\nAfter=network-online.target\nWants=network-online.target\nConditionHost=${hostname}\n\n[Service]\nUser=${os.userInfo().username}\nWorkingDirectory=${workingDirectory}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nEnvironmentFile=${envFile}\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=180\n\n[Install]\nWantedBy=multi-user.target\n`);
    execFileSync("sudo", ["install", "-m", "644", file, `/etc/systemd/system/${name}.service`]);
  }
  execFileSync("sudo", ["systemctl", "daemon-reload"]);
  execFileSync("sudo", ["systemctl", "enable", "--now", ...Object.keys(units)], { stdio: "inherit" });
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
console.info("Private demo surface: https://%s.exe.xyz", hostname);
