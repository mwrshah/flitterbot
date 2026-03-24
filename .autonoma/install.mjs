#!/usr/bin/env node
/**
 * Autonoma installer — Node.js rewrite of install.sh.
 * Standalone ESM script using only node:* built-in modules.
 *
 * Usage: node install.mjs [--dry-run] [--yes] [--with-scheduler] [--without-scheduler]
 */

import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync,
  chmodSync, renameSync, rmSync, readdirSync, unlinkSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HOME = homedir();
const AUTONOMA_DIR = join(HOME, ".autonoma");
const MANIFEST = join(AUTONOMA_DIR, "manifest.json");
const SETTINGS = join(HOME, ".claude", "settings.json");
const PLIST_DEST = join(HOME, "Library", "LaunchAgents", "com.autonoma.scheduler.plist");
const PLIST_LABEL = "com.autonoma.scheduler";
const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");
const SYSTEMD_SERVICE_NAME = "autonoma-scheduler.service";
const SYSTEMD_TIMER_NAME = "autonoma-scheduler.timer";
const SYSTEMD_SERVICE_DEST = join(SYSTEMD_USER_DIR, SYSTEMD_SERVICE_NAME);
const SYSTEMD_TIMER_DEST = join(SYSTEMD_USER_DIR, SYSTEMD_TIMER_NAME);
const LEGACY_CRONTAB_TARGET = "crontab:user";
const HOOKS_DIR = join(AUTONOMA_DIR, "hooks");
const LOG_FILE = join(AUTONOMA_DIR, "logs", "install.log");
const VERSION_FILE = join(AUTONOMA_DIR, "VERSION");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CURRENT_OS = platform() === "darwin" ? "Darwin" : platform() === "linux" ? "Linux" : platform();

let PROJECT_ROOT = "";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
let DRY_RUN = false;
let AUTO_YES = false;
let INSTALL_SCHEDULER = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") DRY_RUN = true;
  else if (arg === "--yes") AUTO_YES = true;
  else if (arg === "--with-scheduler" || arg === "--enable-scheduler") INSTALL_SCHEDULER = true;
  else if (arg === "--without-scheduler" || arg === "--skip-scheduler") INSTALL_SCHEDULER = false;
}

// ---------------------------------------------------------------------------
// File lists
// ---------------------------------------------------------------------------
const TOP_LEVEL_FILES = ["install.mjs", "uninstall.mjs", "VERSION"];

const OBSOLETE_RUNTIME_FILES = [
  "install.sh",
  "uninstall.sh",
  "init.sh",
  "hooks/session-start.sh",
  "hooks/session-end.sh",
  "hooks/stop.sh",
  "hooks/pre-tool-use.sh",
  "hooks/post-tool-use.sh",
  "hooks/post-tool-use-failure.sh",
  "hooks/subagent-start.sh",
  "hooks/subagent-stop.sh",
  "scripts/hook-dispatch.sh",
  "scripts/hook_dispatch.py",
  "scripts/bb_write.py",
  "scripts/bb-write.py",
  "scripts/autonoma_runtime.py",
  "scripts/bb-query.py",
];

const HOOK_EVENTS = ["SessionStart", "Stop", "SessionEnd"];

const HOOK_SCRIPTS = ["hook-post.mjs", "hook-post.mjs", "hook-post.mjs"];

const HOOK_COMMANDS = [
  `node ${HOOKS_DIR}/hook-post.mjs session-start`,
  `node ${HOOKS_DIR}/hook-post.mjs stop`,
  `node ${HOOKS_DIR}/hook-post.mjs session-end`,
];

const SCRIPT_FILES = ["init-db.sh", "runtime-common.sh"];
const SOURCE_FILES = ["blackboard/schema.sql"];
const CRON_FILES = ["autonoma-checkin.sh", "scheduler.sh", "com.autonoma.scheduler.plist"];
const BIN_FILES = ["autonoma-up", "autonoma-wa"];
const WHATSAPP_FILES = ["README.md", "config.json.example"];
const WHATSAPP_EXEC_FILES = ["run-entry.js", "cli.js", "daemon.js"];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileSizeBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function rotateLog(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (fileSizeBytes(path) < 10 * 1024 * 1024) return;
  try { rmSync(path + ".1", { force: true }); } catch {}
  try { renameSync(path, path + ".1"); } catch {}
}

function log(msg) {
  rotateLog(LOG_FILE);
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  try { writeFileSync(LOG_FILE, `[${ts}] ${msg}\n`, { flag: "a" }); } catch {}
}

function info(msg) { console.log(msg); log(`INFO: ${msg}`); }
function warn(msg) { console.error(`WARNING: ${msg}`); log(`WARN: ${msg}`); }
function error(msg) { console.error(`ERROR: ${msg}`); log(`ERROR: ${msg}`); }

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.autonoma.tmp.${randomUUID()}`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readJsonFile(path) {
  const raw = readFileSync(path, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJsonFile(path, obj, mode) {
  atomicWrite(path, JSON.stringify(obj, null, 2) + "\n");
  if (mode != null) chmodSync(path, mode);
}

function canonicalJson(obj) {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = sortKeys(obj[key]);
  return sorted;
}

function prettyJson(obj) {
  return JSON.stringify(obj, null, 2);
}

function sortedPrettyJson(obj) {
  return JSON.stringify(sortKeys(obj), null, 2);
}

function diffText(before, after) {
  try {
    const tmpA = join("/tmp", `.autonoma-diff-a.${process.pid}`);
    const tmpB = join("/tmp", `.autonoma-diff-b.${process.pid}`);
    writeFileSync(tmpA, before);
    writeFileSync(tmpB, after);
    const result = execSync(`diff -u "${tmpA}" "${tmpB}"`, { encoding: "utf8" });
    rmSync(tmpA, { force: true });
    rmSync(tmpB, { force: true });
    return result;
  } catch (e) {
    // diff exits 1 when files differ — output is in stdout
    try { rmSync(`/tmp/.autonoma-diff-a.${process.pid}`, { force: true }); } catch {}
    try { rmSync(`/tmp/.autonoma-diff-b.${process.pid}`, { force: true }); } catch {}
    return e.stdout || "";
  }
}

function showJsonDiff(beforePath, afterObj) {
  if (existsSync(beforePath)) {
    const before = sortedPrettyJson(readJsonFile(beforePath)) + "\n";
    const after = sortedPrettyJson(afterObj) + "\n";
    return diffText(before, after);
  }
  return `--- /dev/null\n+++ proposed\n${sortedPrettyJson(afterObj)}\n`;
}

function showTextDiff(beforePath, afterText) {
  if (existsSync(beforePath)) {
    const before = readFileSync(beforePath, "utf8");
    return diffText(before, afterText);
  }
  return `--- /dev/null\n+++ proposed\n${afterText}${afterText.endsWith("\n") ? "" : "\n"}`;
}

async function confirm(prompt) {
  if (AUTO_YES) return true;
  if (DRY_RUN) {
    info("(dry-run) Would apply above changes.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt || "Apply these changes? [y/N] ", (answer) => {
      rl.close();
      resolve(/^[Yy]$/.test(answer.trim()));
    });
  });
}

function commandExists(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: "pipe" }); return true; } catch { return false; }
}

function generateToken() {
  return randomUUID();
}

function walkDir(dir, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    entries.push(rel);
    if (entry.isDirectory()) entries.push(...walkDir(join(dir, entry.name), rel));
  }
  return entries.sort();
}

// ---------------------------------------------------------------------------
// Manifest operations — all JSON, no jq
// ---------------------------------------------------------------------------
function manifestInit() {
  mkdirSync(AUTONOMA_DIR, { recursive: true });
  if (existsSync(MANIFEST)) {
    try { readJsonFile(MANIFEST); } catch {
      const backup = `${MANIFEST}.bak.${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "T").slice(0, 15)}Z`;
      warn(`Manifest is malformed. Backing it up to ${backup} and recreating.`);
      renameSync(MANIFEST, backup);
    }
  }
  if (!existsSync(MANIFEST)) {
    atomicWrite(MANIFEST, JSON.stringify({
      version: "1", autonoma_version: "0.0.0", installed_at: null, targets: {},
    }, null, 2) + "\n");
    chmodSync(MANIFEST, 0o600);
  }
}

function manifestWriteTarget(targetKey, targetObj) {
  manifestInit();
  const manifest = readJsonFile(MANIFEST);
  const version = readFileSync(VERSION_FILE, "utf8").trim();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  manifest.version = "1";
  manifest.autonoma_version = version;
  manifest.installed_at = now;
  manifest.targets[targetKey] = targetObj;
  writeJsonFile(MANIFEST, manifest, 0o600);
}

function manifestDeleteTarget(targetKey) {
  if (!existsSync(MANIFEST)) return;
  let manifest;
  try { manifest = readJsonFile(MANIFEST); } catch { return; }
  if (!manifest.targets || manifest.targets[targetKey] == null) return;
  delete manifest.targets[targetKey];
  writeJsonFile(MANIFEST, manifest, 0o600);
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------
function resolvePackagedRuntimeFile(rel) {
  const candidates = [
    PROJECT_ROOT && join(PROJECT_ROOT, ".autonoma", rel),
    join(SCRIPT_DIR, rel),
    join(AUTONOMA_DIR, rel),
    join(SCRIPT_DIR, "..", ".autonoma", rel),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function resolvePackagedSrcFile(rel) {
  const candidates = [
    PROJECT_ROOT && join(PROJECT_ROOT, "src", rel),
    join(AUTONOMA_DIR, "src", rel),
    join(SCRIPT_DIR, "src", rel),
    join(SCRIPT_DIR, "..", "src", rel),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// Runtime file deployment helpers
// ---------------------------------------------------------------------------
function copyRuntimeFile(src, dest, mode) {
  mkdirSync(dirname(dest), { recursive: true });
  if (src !== dest) copyFileSync(src, dest);
  chmodSync(dest, mode);
}

function writeRuntimeFile(dest, content, mode) {
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, content);
  chmodSync(dest, mode);
}

// Change tracking
let RUNTIME_CHANGES = "";

function appendRuntimeChange(action, path) {
  RUNTIME_CHANGES += `${action} ${path}\n`;
}

function noteRemovedRuntimeFile(path) {
  if (existsSync(path)) appendRuntimeChange("remove", path);
}

function noteRuntimeFile(src, dest) {
  if (!existsSync(dest)) {
    appendRuntimeChange("create", dest);
    return;
  }
  if (sha256File(src) !== sha256File(dest)) appendRuntimeChange("update", dest);
}

function noteTextFile(dest, content) {
  if (!existsSync(dest)) {
    appendRuntimeChange("create", dest);
    return;
  }
  const existing = readFileSync(dest, "utf8");
  if (existing !== content) appendRuntimeChange("update", dest);
}

function snapshotRuntimeTree() {
  if (!existsSync(AUTONOMA_DIR)) return [];
  return walkDir(AUTONOMA_DIR);
}

function recordRuntimeTreeTarget() {
  if (DRY_RUN) return;
  const paths = snapshotRuntimeTree();
  const treeHash = sha256Text(JSON.stringify(paths));
  manifestWriteTarget("~/.autonoma", {
    type: "owned-tree",
    modifications: [{
      id: "autonoma:home-tree",
      action: "sync-tree",
      paths,
      content_sha256: treeHash,
    }],
    checksums: {
      algorithm: "sha256",
      file_before_install: null,
      file_after_install: treeHash,
    },
  });
}

// ---------------------------------------------------------------------------
// systemd helpers
// ---------------------------------------------------------------------------
function systemctlUserAvailable() {
  try {
    execSync("systemctl --user show-environment", { stdio: "pipe" });
    return true;
  } catch { return false; }
}

function renderSystemdService() {
  return `[Unit]
Description=Autonoma scheduler check-in
After=default.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${AUTONOMA_DIR}/cron/autonoma-checkin.sh
WorkingDirectory=${HOME}
`;
}

function renderSystemdTimer() {
  return `[Unit]
Description=Run Autonoma scheduler every 10 minutes

[Timer]
OnBootSec=2m
OnUnitActiveSec=10m
AccuracySec=1m
Persistent=true
Unit=${SYSTEMD_SERVICE_NAME}

[Install]
WantedBy=timers.target
`;
}

function computeLegacyCrontabAfterText(beforeText) {
  return beforeText
    .split("\n")
    .filter((line) => !line.includes("# autonoma-scheduler"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

function applyLegacyCrontabText(afterText) {
  const trimmed = afterText.replace(/\s/g, "");
  if (trimmed) {
    const tmp = `/tmp/autonoma-crontab.${process.pid}`;
    writeFileSync(tmp, afterText + "\n");
    try { execSync(`crontab "${tmp}"`, { stdio: "pipe" }); } finally { rmSync(tmp, { force: true }); }
  } else {
    try { execSync("crontab -r", { stdio: "pipe" }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
function computeProjectRoot() {
  if (existsSync(join(SCRIPT_DIR, "..", "features")) && existsSync(join(SCRIPT_DIR, "..", "src"))) {
    PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
    return;
  }
  const sourceRootFile = join(AUTONOMA_DIR, "source-root");
  if (existsSync(sourceRootFile)) {
    PROJECT_ROOT = readFileSync(sourceRootFile, "utf8").trim();
    return;
  }
  PROJECT_ROOT = "";
}

function prepareDirectories() {
  const dirs = [
    AUTONOMA_DIR,
    join(AUTONOMA_DIR, "bin"),
    ...(INSTALL_SCHEDULER ? [join(AUTONOMA_DIR, "cron")] : []),
    join(AUTONOMA_DIR, "control-surface"),
    join(AUTONOMA_DIR, "hooks"),
    join(AUTONOMA_DIR, "logs"),
    join(AUTONOMA_DIR, "scripts"),
    join(AUTONOMA_DIR, "src", "blackboard"),
    join(AUTONOMA_DIR, "whatsapp", "auth"),
    join(AUTONOMA_DIR, "whatsapp", "logs"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  try { chmodSync(join(AUTONOMA_DIR, "whatsapp", "auth"), 0o700); } catch {}
  try { chmodSync(join(AUTONOMA_DIR, "whatsapp", "logs"), 0o700); } catch {}
}

function preflight() {
  if (CURRENT_OS === "Darwin") {
    if (!commandExists("plutil")) { error("plutil is required on macOS."); process.exit(1); }
    if (!commandExists("launchctl")) { error("launchctl is required on macOS."); process.exit(1); }
  } else if (CURRENT_OS === "Linux") {
    if (!commandExists("systemctl")) {
      warn("systemctl not found; Linux scheduler install will be skipped.");
    }
  } else {
    warn(`Unsupported OS: ${CURRENT_OS}. Hooks will install, scheduler may be skipped.`);
  }

  computeProjectRoot();
  prepareDirectories();

  let version = "0.1.0";
  const versionSrc = join(SCRIPT_DIR, "VERSION");
  if (existsSync(versionSrc)) version = readFileSync(versionSrc, "utf8").trim();
  writeFileSync(VERSION_FILE, version + "\n");

  info(`Autonoma Installer v${version}`);
  info("==========================");
  if (DRY_RUN) info("(dry-run mode — no changes will be written)");
  info(INSTALL_SCHEDULER
    ? "Scheduler install: enabled"
    : "Scheduler install: skipped by default (pass --with-scheduler to enable)");
  info("");
}

// ---------------------------------------------------------------------------
// Bootstrap config.json
// ---------------------------------------------------------------------------
async function bootstrapConfig() {
  const configPath = join(AUTONOMA_DIR, "config.json");
  let configBefore = {};
  let beforeHash = "null";

  if (existsSync(configPath)) {
    try { configBefore = readJsonFile(configPath); } catch {
      error(`Config is malformed JSON: ${configPath}`);
      process.exit(1);
    }
    beforeHash = sha256File(configPath);
  }

  let token = configBefore.controlSurfaceToken || "";
  if (!token) token = generateToken();

  let projectRoot = configBefore.projectRoot || configBefore.sourceRoot || "";
  if (!projectRoot && PROJECT_ROOT) projectRoot = PROJECT_ROOT;

  let commandHint = configBefore.controlSurfaceCommand || "";
  if (!commandHint && projectRoot) {
    if (existsSync(join(projectRoot, "dist", "control-surface", "server.js"))) {
      commandHint = `cd ${projectRoot} && exec node ${join(projectRoot, "dist", "control-surface", "server.js")}`;
    } else if (existsSync(join(projectRoot, "src", "control-surface", "server.ts"))) {
      commandHint = `cd ${projectRoot} && exec node --experimental-strip-types ${join(projectRoot, "src", "control-surface", "server.ts")}`;
    }
  }

  const configAfter = { ...configBefore };
  configAfter.controlSurfaceHost = configAfter.controlSurfaceHost || "127.0.0.1";
  configAfter.controlSurfacePort = configAfter.controlSurfacePort || 18820;
  if (!configAfter.controlSurfaceToken) configAfter.controlSurfaceToken = token;
  configAfter.piModel = configAfter.piModel || "claude-opus-4-6";
  configAfter.piThinkingLevel = configAfter.piThinkingLevel || "low";
  configAfter.stallMinutes = configAfter.stallMinutes || 15;
  configAfter.toolTimeoutMinutes = configAfter.toolTimeoutMinutes || 60;
  configAfter.blackboardPath = configAfter.blackboardPath || "~/.autonoma/blackboard.db";
  configAfter.whatsappAuthDir = configAfter.whatsappAuthDir || "~/.autonoma/whatsapp/auth";
  configAfter.whatsappSocketPath = configAfter.whatsappSocketPath || "~/.autonoma/whatsapp/daemon.sock";
  configAfter.whatsappPidPath = configAfter.whatsappPidPath || "~/.autonoma/whatsapp/daemon.pid";
  configAfter.whatsappCliPath = configAfter.whatsappCliPath || "~/.autonoma/whatsapp/cli.js";
  configAfter.whatsappDaemonPath = configAfter.whatsappDaemonPath || "~/.autonoma/whatsapp/daemon.js";
  if (configAfter.whatsappEnabled === undefined) configAfter.whatsappEnabled = true;
  if (configAfter.wipeWorkstreamsOnStart === undefined) configAfter.wipeWorkstreamsOnStart = false;
  if (!configAfter.projectsDir) {
    const entered = await promptString(
      "Projects directory (absolute path where your repos live, e.g. ~/Documents/coded-programs): ",
    );
    if (entered) configAfter.projectsDir = entered;
  }
  if (!configAfter.claudeCliCommand || configAfter.claudeCliCommand === "claude") {
    configAfter.claudeCliCommand = "claude --dangerously-skip-permissions";
  }
  if (!configAfter.projectRoot) configAfter.projectRoot = projectRoot;
  if (!configAfter.sourceRoot) configAfter.sourceRoot = configAfter.projectRoot || projectRoot;
  if (!configAfter.controlSurfaceCommand) configAfter.controlSurfaceCommand = commandHint;

  if (canonicalJson(configBefore) !== canonicalJson(configAfter)) {
    info("=== Runtime config changes ===");
    console.log(showJsonDiff(configPath, configAfter));
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        writeJsonFile(configPath, configAfter, 0o600);
        const afterHash = sha256File(configPath);
        log(`INFO: Bootstrapped config.json before=${beforeHash} after=${afterHash}`);
      }
    } else {
      info("Skipped config bootstrap update.");
    }
  }

  // Always sync token to web/.env so the frontend can authenticate
  await syncWebEnv(configAfter);
}

async function syncWebEnv(config) {
  if (!PROJECT_ROOT) return;
  const webEnvPath = join(PROJECT_ROOT, "web", ".env");
  const baseUrl = `http://${config.controlSurfaceHost || "127.0.0.1"}:${config.controlSurfacePort || 18820}`;
  const token = config.controlSurfaceToken || "";
  const desired = `VITE_AUTONOMA_BASE_URL=${baseUrl}\nVITE_AUTONOMA_TOKEN=${token}\n`;

  const beforeHash = existsSync(webEnvPath) ? sha256File(webEnvPath) : "";

  if (existsSync(webEnvPath)) {
    const existing = readFileSync(webEnvPath, "utf8");
    if (existing === desired) return;
  }

  info("=== Web app .env sync ===");
  console.log(showTextDiff(webEnvPath, desired));
  info("");

  if (await confirm()) {
    if (!DRY_RUN) {
      writeRuntimeFile(webEnvPath, desired, 0o600);
      const afterHash = sha256File(webEnvPath);
      manifestWriteTarget("web/.env", {
        type: "file-create",
        modifications: [{ id: "web-env:sync", action: "upsert", content_sha256: afterHash }],
        checksums: {
          algorithm: "sha256",
          file_before_install: beforeHash || null,
          file_after_install: afterHash,
        },
      });
      info(`Wrote ${webEnvPath}`);
    }
  } else {
    info("Skipped web .env sync.");
  }
}

// ---------------------------------------------------------------------------
// WhatsApp config bootstrap
// ---------------------------------------------------------------------------
async function promptString(promptText) {
  if (AUTO_YES || DRY_RUN) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.replace(/[\t\r\n]/g, "").trim());
    });
  });
}

async function promptWhatsappPhone(promptText) {
  if (AUTO_YES || DRY_RUN) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const entered = answer.replace(/[\t\r\n]/g, "").trim();
      if (!entered) { resolve(""); return; }
      const normalized = entered.replace(/\D/g, "");
      if (normalized) { resolve(normalized); return; }
      warn("Please enter digits only (country code included), or leave blank to skip.");
      resolve("");
    });
  });
}

async function bootstrapWhatsappConfig() {
  const whatsappConfig = join(AUTONOMA_DIR, "whatsapp", "config.json");
  if (existsSync(whatsappConfig)) {
    try { readJsonFile(whatsappConfig); return; } catch {
      error(`WhatsApp config is malformed JSON: ${whatsappConfig}`);
      process.exit(1);
    }
  }

  const pairingPhone = await promptWhatsappPhone(
    "WhatsApp phone number for pairing (digits with country code, blank to skip for now): ",
  );
  const recipientJid = pairingPhone || "";

  const whatsappAfter = {
    recipientJid,
    pairingPhoneNumber: pairingPhone,
    typingDelayMs: 800,
  };

  info("=== WhatsApp config bootstrap ===");
  console.log(`--- /dev/null\n+++ proposed\n${sortedPrettyJson(whatsappAfter)}`);
  if (pairingPhone) {
    info("");
    info(`Using ${pairingPhone} for both pairingPhoneNumber and recipientJid.`);
  }
  info("");

  if (await confirm()) {
    if (!DRY_RUN) writeJsonFile(whatsappConfig, whatsappAfter, 0o600);
  } else {
    info("Skipped WhatsApp config bootstrap.");
  }
}

// ---------------------------------------------------------------------------
// Blackboard initialization
// ---------------------------------------------------------------------------
function initBlackboard() {
  const initScript = join(AUTONOMA_DIR, "scripts", "init-db.sh");
  if (!existsSync(initScript)) {
    warn("init-db.sh not available; skipping blackboard initialization");
    return;
  }

  if (DRY_RUN) {
    info("(dry-run) Would initialize blackboard.db");
    return;
  }

  // Read blackboardPath from config to pass as env so init-db.sh skips jq
  let dbPath = "";
  const configPath = join(AUTONOMA_DIR, "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = readJsonFile(configPath);
      if (cfg.blackboardPath) {
        dbPath = cfg.blackboardPath.replace(/^~/, HOME);
      }
    } catch {}
  }

  const env = { ...process.env, AUTONOMA_HOME: AUTONOMA_DIR };
  if (dbPath) env.AUTONOMA_DB_PATH = dbPath;

  try {
    execSync(`bash "${initScript}"`, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    warn(`Blackboard initialization reported an error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Deploy runtime files
// ---------------------------------------------------------------------------
async function deployRuntimeFiles() {
  RUNTIME_CHANGES = "";

  // Note changes for all file categories
  for (const file of TOP_LEVEL_FILES) {
    const src = resolvePackagedRuntimeFile(file);
    if (!src) continue;
    noteRuntimeFile(src, join(AUTONOMA_DIR, file));
  }

  const seenHooks = new Set();
  for (const file of HOOK_SCRIPTS) {
    if (seenHooks.has(file)) continue;
    seenHooks.add(file);
    const src = resolvePackagedRuntimeFile(`hooks/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(AUTONOMA_DIR, "hooks", file));
  }

  for (const file of SCRIPT_FILES) {
    const src = resolvePackagedRuntimeFile(`scripts/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(AUTONOMA_DIR, "scripts", file));
  }

  if (INSTALL_SCHEDULER) {
    for (const file of CRON_FILES) {
      const src = resolvePackagedRuntimeFile(`cron/${file}`);
      if (!src) continue;
      noteRuntimeFile(src, join(AUTONOMA_DIR, "cron", file));
    }
  }

  for (const file of SOURCE_FILES) {
    const src = resolvePackagedSrcFile(file);
    if (!src) continue;
    noteRuntimeFile(src, join(AUTONOMA_DIR, "src", file));
  }

  for (const file of BIN_FILES) {
    const src = resolvePackagedRuntimeFile(`bin/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(AUTONOMA_DIR, "bin", file));
  }

  for (const file of WHATSAPP_FILES) {
    const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(AUTONOMA_DIR, "whatsapp", file));
  }

  for (const file of WHATSAPP_EXEC_FILES) {
    const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(AUTONOMA_DIR, "whatsapp", file));
  }

  if (PROJECT_ROOT) {
    noteTextFile(join(AUTONOMA_DIR, "source-root"), PROJECT_ROOT + "\n");
  }

  for (const obsolete of OBSOLETE_RUNTIME_FILES) {
    noteRemovedRuntimeFile(join(AUTONOMA_DIR, obsolete));
  }

  if (!RUNTIME_CHANGES) {
    info("Runtime files already up to date.");
  } else {
    info("=== Runtime file deployment ===");
    process.stdout.write(RUNTIME_CHANGES);
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        for (const file of TOP_LEVEL_FILES) {
          const src = resolvePackagedRuntimeFile(file);
          if (!src) continue;
          copyRuntimeFile(src, join(AUTONOMA_DIR, file), 0o755);
        }

        const seenCopy = new Set();
        for (const file of HOOK_SCRIPTS) {
          if (seenCopy.has(file)) continue;
          seenCopy.add(file);
          const src = resolvePackagedRuntimeFile(`hooks/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(AUTONOMA_DIR, "hooks", file), 0o755);
        }

        for (const file of SCRIPT_FILES) {
          const src = resolvePackagedRuntimeFile(`scripts/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(AUTONOMA_DIR, "scripts", file), 0o755);
        }

        if (INSTALL_SCHEDULER) {
          for (const file of CRON_FILES) {
            const src = resolvePackagedRuntimeFile(`cron/${file}`);
            if (!src) continue;
            copyRuntimeFile(src, join(AUTONOMA_DIR, "cron", file), 0o755);
          }
        }

        for (const file of SOURCE_FILES) {
          const src = resolvePackagedSrcFile(file);
          if (!src) continue;
          copyRuntimeFile(src, join(AUTONOMA_DIR, "src", file), 0o644);
        }

        for (const file of BIN_FILES) {
          const src = resolvePackagedRuntimeFile(`bin/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(AUTONOMA_DIR, "bin", file), 0o755);
        }

        for (const file of WHATSAPP_FILES) {
          const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(AUTONOMA_DIR, "whatsapp", file), 0o644);
        }

        for (const file of WHATSAPP_EXEC_FILES) {
          const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(AUTONOMA_DIR, "whatsapp", file), 0o755);
        }

        if (PROJECT_ROOT) {
          writeRuntimeFile(join(AUTONOMA_DIR, "source-root"), PROJECT_ROOT + "\n", 0o644);
        }

        for (const obsolete of OBSOLETE_RUNTIME_FILES) {
          rmSync(join(AUTONOMA_DIR, obsolete), { force: true, recursive: true });
        }
      }
    } else {
      info("Skipped runtime file deployment.");
    }
  }

  await bootstrapConfig();
  await bootstrapWhatsappConfig();
  initBlackboard();
  recordRuntimeTreeTarget();
}

// ---------------------------------------------------------------------------
// Install hooks into settings.json
// ---------------------------------------------------------------------------
async function installHooks() {
  let settingsBefore = {};
  let beforeHash = "null";
  const prefix = `${HOOKS_DIR}/`;
  const prefixNode = `node ${HOOKS_DIR}/`;

  if (existsSync(SETTINGS)) {
    try { settingsBefore = readJsonFile(SETTINGS); } catch {
      error("settings.json is malformed JSON. Aborting.");
      process.exit(1);
    }
    beforeHash = sha256File(SETTINGS);
  }

  // Ensure hooks object exists
  let current = { ...settingsBefore };
  if (!current.hooks || typeof current.hooks !== "object") current.hooks = {};

  const isAutonomaGroup = (group) => {
    return (group.hooks || []).some((h) => {
      const cmd = h.command || "";
      return cmd.startsWith(prefix) || cmd.startsWith(prefixNode);
    });
  };

  // Remove Autonoma hooks from deprecated events
  let changes = false;
  const deprecatedEvents = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop"];
  for (const event of deprecatedEvents) {
    const groups = current.hooks[event] || [];
    const filtered = groups.filter((g) => !isAutonomaGroup(g));
    if (filtered.length !== groups.length) {
      if (filtered.length === 0) {
        delete current.hooks[event];
      } else {
        current.hooks[event] = filtered;
      }
      changes = true;
    }
  }

  // Install/update current hook events
  const modifications = [];
  for (let idx = 0; idx < HOOK_EVENTS.length; idx++) {
    const event = HOOK_EVENTS[idx];
    const hookCmd = HOOK_COMMANDS[idx];
    const desiredGroup = {
      matcher: "",
      hooks: [{ type: "command", command: hookCmd, async: true, timeout: 15 }],
    };

    const groups = current.hooks[event] || [];
    const autonomaGroups = groups.filter(isAutonomaGroup);
    const identicalGroups = autonomaGroups.filter((g) => canonicalJson(g) === canonicalJson(desiredGroup));

    if (autonomaGroups.length !== 1 || identicalGroups.length !== 1) {
      const nonAutonoma = groups.filter((g) => !isAutonomaGroup(g));
      current.hooks[event] = [...nonAutonoma, desiredGroup];
      changes = true;
    }

    modifications.push({
      id: `hook:${event}`,
      action: "append",
      content: desiredGroup,
      content_sha256: sha256Text(canonicalJson(desiredGroup)),
    });
  }

  // Clean up empty hooks object
  if (Object.keys(current.hooks).length === 0) delete current.hooks;

  if (!changes && existsSync(SETTINGS)) {
    info("Hooks already installed. No changes needed.");
  } else {
    info(`=== Hook changes to ${SETTINGS} ===`);
    console.log(showJsonDiff(SETTINGS, current));
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        mkdirSync(dirname(SETTINGS), { recursive: true });
        writeJsonFile(SETTINGS, current);
      }
    } else {
      info("Skipped hooks install.");
      return;
    }
  }

  if (!DRY_RUN) {
    let afterHash = beforeHash;
    if (existsSync(SETTINGS)) afterHash = sha256File(SETTINGS);

    manifestWriteTarget("~/.claude/settings.json", {
      type: "json-merge",
      modifications,
      checksums: {
        algorithm: "sha256",
        file_before_install: beforeHash === "null" ? null : beforeHash,
        file_after_install: afterHash === "null" ? null : afterHash,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler: launchd (macOS)
// ---------------------------------------------------------------------------
async function installLaunchd() {
  if (CURRENT_OS !== "Darwin") return;

  const plistSrc = join(SCRIPT_DIR, "cron", "com.autonoma.scheduler.plist");
  if (!existsSync(plistSrc)) { warn(`Missing plist template: ${plistSrc}`); return; }

  let plistContent = readFileSync(plistSrc, "utf8");
  plistContent = plistContent.replaceAll("__HOME__", HOME);
  plistContent = plistContent.replaceAll("__AUTONOMA_DIR__", AUTONOMA_DIR);

  let beforeHash = "null";
  if (existsSync(PLIST_DEST)) beforeHash = sha256File(PLIST_DEST);

  // Validate plist
  const tmpPlist = `/tmp/autonoma-plist.${process.pid}`;
  writeFileSync(tmpPlist, plistContent);
  try {
    execSync(`plutil -lint "${tmpPlist}"`, { stdio: "pipe" });
  } catch {
    rmSync(tmpPlist, { force: true });
    error("Generated plist is invalid.");
    process.exit(1);
  }

  const newHash = sha256Text(plistContent);
  const existingHash = existsSync(PLIST_DEST) ? sha256File(PLIST_DEST) : "";

  if (existingHash === newHash) {
    info("launchd plist already installed. No changes needed.");
  } else {
    info("=== launchd changes ===");
    console.log(showTextDiff(PLIST_DEST, plistContent));
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        mkdirSync(dirname(PLIST_DEST), { recursive: true });
        try { execSync(`launchctl bootout gui/$(id -u) "${PLIST_DEST}"`, { stdio: "pipe" }); } catch {}
        atomicWrite(PLIST_DEST, plistContent);
        chmodSync(PLIST_DEST, 0o644);
        try { execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_DEST}"`, { stdio: "pipe" }); } catch {}
      }
    } else {
      rmSync(tmpPlist, { force: true });
      info("Skipped launchd install.");
      return;
    }
  }
  rmSync(tmpPlist, { force: true });

  if (!DRY_RUN) {
    const afterHash = sha256File(PLIST_DEST);
    manifestWriteTarget("~/Library/LaunchAgents/com.autonoma.scheduler.plist", {
      type: "file-create",
      modifications: [{ id: "launchd:scheduler", action: "insert", content_sha256: afterHash }],
      checksums: {
        algorithm: "sha256",
        file_before_install: beforeHash === "null" ? null : beforeHash,
        file_after_install: afterHash,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler: systemd (Linux)
// ---------------------------------------------------------------------------
async function installLinuxSystemd() {
  if (CURRENT_OS !== "Linux") return;
  if (!systemctlUserAvailable()) {
    warn("systemd --user is unavailable; skipping Linux scheduler install.");
    return;
  }

  const serviceContent = renderSystemdService();
  const timerContent = renderSystemdTimer();

  let serviceBeforeHash = "null";
  let timerBeforeHash = "null";
  let serviceExistingHash = "";
  let timerExistingHash = "";

  if (existsSync(SYSTEMD_SERVICE_DEST)) {
    serviceBeforeHash = sha256File(SYSTEMD_SERVICE_DEST);
    serviceExistingHash = serviceBeforeHash;
  }
  if (existsSync(SYSTEMD_TIMER_DEST)) {
    timerBeforeHash = sha256File(SYSTEMD_TIMER_DEST);
    timerExistingHash = timerBeforeHash;
  }

  let needsChanges = false;
  if (serviceExistingHash !== sha256Text(serviceContent)) needsChanges = true;
  if (timerExistingHash !== sha256Text(timerContent)) needsChanges = true;

  let timerEnabled = false;
  let timerActive = false;
  try { execSync(`systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" }); timerEnabled = true; } catch {}
  try { execSync(`systemctl --user is-active ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" }); timerActive = true; } catch {}
  if (!timerEnabled || !timerActive) needsChanges = true;

  let legacyBeforeText = "";
  let legacyAfterText = "";
  let legacyCleanupNeeded = false;
  if (commandExists("crontab")) {
    try { legacyBeforeText = execSync("crontab -l", { encoding: "utf8" }); } catch { legacyBeforeText = ""; }
    legacyAfterText = computeLegacyCrontabAfterText(legacyBeforeText);
    if (legacyBeforeText !== legacyAfterText) {
      legacyCleanupNeeded = true;
      needsChanges = true;
    }
  }

  if (!needsChanges) {
    info("Linux systemd user timer already installed. No changes needed.");
  } else {
    info("=== systemd user scheduler changes ===");
    console.log(showTextDiff(SYSTEMD_SERVICE_DEST, serviceContent));
    info("");
    console.log(showTextDiff(SYSTEMD_TIMER_DEST, timerContent));
    info("");
    if (!timerEnabled || !timerActive) {
      info(`Will run: systemctl --user enable --now ${SYSTEMD_TIMER_NAME}`);
      info("");
    }
    if (legacyCleanupNeeded) {
      info("=== Legacy crontab cleanup ===");
      console.log(diffText(legacyBeforeText + "\n", legacyAfterText + "\n"));
      info("");
    }

    if (await confirm()) {
      if (!DRY_RUN) {
        mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
        atomicWrite(SYSTEMD_SERVICE_DEST, serviceContent);
        chmodSync(SYSTEMD_SERVICE_DEST, 0o644);
        atomicWrite(SYSTEMD_TIMER_DEST, timerContent);
        chmodSync(SYSTEMD_TIMER_DEST, 0o644);
        execSync("systemctl --user daemon-reload", { stdio: "pipe" });
        try {
          execSync(`systemctl --user enable --now ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" });
        } catch {
          warn(`Failed to enable/start ${SYSTEMD_TIMER_NAME}`);
        }
        if (legacyCleanupNeeded) {
          applyLegacyCrontabText(legacyAfterText);
          manifestDeleteTarget(LEGACY_CRONTAB_TARGET);
        }
      }
    } else {
      info("Skipped Linux systemd scheduler install.");
      return;
    }
  }

  if (!DRY_RUN) {
    const serviceAfterHash = sha256File(SYSTEMD_SERVICE_DEST);
    const timerAfterHash = sha256File(SYSTEMD_TIMER_DEST);

    manifestWriteTarget("~/.config/systemd/user/autonoma-scheduler.service", {
      type: "file-create",
      modifications: [{ id: "systemd-user:scheduler-service", action: "upsert", content_sha256: serviceAfterHash }],
      checksums: {
        algorithm: "sha256",
        file_before_install: serviceBeforeHash === "null" ? null : serviceBeforeHash,
        file_after_install: serviceAfterHash,
      },
    });

    manifestWriteTarget("~/.config/systemd/user/autonoma-scheduler.timer", {
      type: "file-create",
      modifications: [{ id: "systemd-user:scheduler-timer", action: "upsert", content_sha256: timerAfterHash }],
      checksums: {
        algorithm: "sha256",
        file_before_install: timerBeforeHash === "null" ? null : timerBeforeHash,
        file_after_install: timerAfterHash,
      },
    });
  }
}

async function installScheduler() {
  await installLaunchd();
  await installLinuxSystemd();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  preflight();
  await deployRuntimeFiles();
  await installHooks();
  if (INSTALL_SCHEDULER) {
    await installScheduler();
  } else {
    info("Skipping scheduler installation.");
  }
  info("");
  info("Installation complete.");
  if (!INSTALL_SCHEDULER) {
    info("Scheduler not installed. Re-run with --with-scheduler when ready.");
  }
  info(`To uninstall: ${AUTONOMA_DIR}/uninstall.mjs`);
}

main().catch((e) => {
  error(`Install failed: ${e.message}`);
  process.exit(1);
});
