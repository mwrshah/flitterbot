#!/usr/bin/env node
/**
 * Autonoma uninstaller — Node.js rewrite of uninstall.sh.
 * Standalone ESM script using only node:* built-in modules.
 *
 * Usage: node uninstall.mjs [--dry-run] [--yes] [--meta] [--external-only]
 */

import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
  chmodSync, renameSync, rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HOME = homedir();
const AUTONOMA_DIR = join(HOME, ".autonoma");
const MANIFEST = join(AUTONOMA_DIR, "manifest.json");
const SETTINGS = join(HOME, ".claude", "settings.json");
const PLIST = join(HOME, "Library", "LaunchAgents", "com.autonoma.scheduler.plist");
const PLIST_LABEL = "com.autonoma.scheduler";
const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");
const SYSTEMD_SERVICE_NAME = "autonoma-scheduler.service";
const SYSTEMD_TIMER_NAME = "autonoma-scheduler.timer";
const SYSTEMD_SERVICE_DEST = join(SYSTEMD_USER_DIR, SYSTEMD_SERVICE_NAME);
const SYSTEMD_TIMER_DEST = join(SYSTEMD_USER_DIR, SYSTEMD_TIMER_NAME);
const LEGACY_CRONTAB_TARGET = "crontab:user";
const LOG_FILE = join(AUTONOMA_DIR, "logs", "install.log");
const CURRENT_OS = platform() === "darwin" ? "Darwin" : platform() === "linux" ? "Linux" : platform();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
let DRY_RUN = false;
let AUTO_YES = false;
let REMOVE_RUNTIME = true;
let MANIFEST_AVAILABLE = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") DRY_RUN = true;
  else if (arg === "--yes") AUTO_YES = true;
  else if (arg === "--meta") REMOVE_RUNTIME = true;
  else if (arg === "--external-only") REMOVE_RUNTIME = false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
let LOG_ENABLED = true;

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
  if (!LOG_ENABLED) return;
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

function sortKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = sortKeys(obj[key]);
  return sorted;
}

function sortedPrettyJson(obj) {
  return JSON.stringify(sortKeys(obj), null, 2);
}

function canonicalJson(obj) {
  return JSON.stringify(sortKeys(obj));
}

function diffText(before, after) {
  try {
    const tmpA = `/tmp/.autonoma-diff-a.${process.pid}`;
    const tmpB = `/tmp/.autonoma-diff-b.${process.pid}`;
    writeFileSync(tmpA, before);
    writeFileSync(tmpB, after);
    const result = execSync(`diff -u "${tmpA}" "${tmpB}"`, { encoding: "utf8" });
    rmSync(tmpA, { force: true });
    rmSync(tmpB, { force: true });
    return result;
  } catch (e) {
    try { rmSync(`/tmp/.autonoma-diff-a.${process.pid}`, { force: true }); } catch {}
    try { rmSync(`/tmp/.autonoma-diff-b.${process.pid}`, { force: true }); } catch {}
    return e.stdout || "";
  }
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

// ---------------------------------------------------------------------------
// Manifest operations
// ---------------------------------------------------------------------------
function manifestDeleteTarget(targetKey) {
  if (!MANIFEST_AVAILABLE) return;
  let manifest;
  try { manifest = readJsonFile(MANIFEST); } catch { return; }
  if (!manifest.targets || manifest.targets[targetKey] == null) return;
  delete manifest.targets[targetKey];
  writeJsonFile(MANIFEST, manifest, 0o600);
}

function manifestTargetExists(targetKey) {
  if (!MANIFEST_AVAILABLE) return false;
  try {
    const manifest = readJsonFile(MANIFEST);
    return manifest.targets && manifest.targets[targetKey] != null;
  } catch { return false; }
}

function manifestGetTarget(targetKey) {
  if (!MANIFEST_AVAILABLE) return null;
  try {
    const manifest = readJsonFile(MANIFEST);
    return (manifest.targets && manifest.targets[targetKey]) || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Prereqs
// ---------------------------------------------------------------------------
function ensurePrereqs() {
  mkdirSync(join(AUTONOMA_DIR, "logs"), { recursive: true });

  if (existsSync(MANIFEST)) {
    try {
      readJsonFile(MANIFEST);
      MANIFEST_AVAILABLE = true;
    } catch {
      error("Manifest is malformed JSON. Aborting.");
      process.exit(1);
    }
    return;
  }

  warn(`Manifest not found at ${MANIFEST}. Proceeding with best-effort uninstall.`);
}

// ---------------------------------------------------------------------------
// Uninstall hooks
// ---------------------------------------------------------------------------
async function uninstallHooks() {
  if (!existsSync(SETTINGS)) {
    if (manifestTargetExists("~/.claude/settings.json")) {
      warn("settings.json is missing. Clearing manifest hook entries.");
      if (!DRY_RUN) manifestDeleteTarget("~/.claude/settings.json");
    } else {
      info("settings.json is absent. Hooks already removed.");
    }
    return;
  }

  let settings;
  try { settings = readJsonFile(SETTINGS); } catch {
    error("settings.json is malformed JSON. Aborting hooks uninstall.");
    process.exit(1);
  }

  const prefix = `${HOME}/.autonoma/hooks/`;
  const prefixNode = `node ${HOME}/.autonoma/hooks/`;

  // Drift detection
  if (manifestTargetExists("~/.claude/settings.json")) {
    const target = manifestGetTarget("~/.claude/settings.json");
    const expectedHash = target?.checksums?.file_after_install || "";
    if (expectedHash) {
      const currentHash = sha256File(SETTINGS);
      if (expectedHash !== currentHash) {
        warn("settings.json has drifted since installation. Attempting surgical removal of Autonoma hooks only.");
      }
    }

    // Check if manifest-tracked entries were externally modified
    const mods = target?.modifications || [];
    const allHookEntries = [];
    if (settings.hooks) {
      for (const groups of Object.values(settings.hooks)) {
        if (Array.isArray(groups)) allHookEntries.push(...groups);
      }
    }
    const missingExact = mods.filter((mod) => {
      const content = mod.content;
      if (!content) return false;
      return !allHookEntries.some((g) => canonicalJson(g) === canonicalJson(content));
    });
    if (missingExact.length > 0) {
      warn("One or more manifest-tracked hook entries were already changed or removed externally.");
    }
  }

  const isAutonomaGroup = (group) => {
    return (group.hooks || []).some((h) => {
      const cmd = h.command || "";
      return cmd.startsWith(prefix) || cmd.startsWith(prefixNode);
    });
  };

  // Filter out Autonoma hooks
  const filtered = { ...settings };
  if (filtered.hooks && typeof filtered.hooks === "object") {
    const newHooks = {};
    for (const [event, groups] of Object.entries(filtered.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((g) => !isAutonomaGroup(g));
      if (kept.length > 0) newHooks[event] = kept;
    }
    if (Object.keys(newHooks).length > 0) {
      filtered.hooks = newHooks;
    } else {
      delete filtered.hooks;
    }
  }

  // Check if anything changed
  if (canonicalJson(settings) === canonicalJson(filtered)) {
    info("Autonoma hook entries are already absent.");
    if (!DRY_RUN) manifestDeleteTarget("~/.claude/settings.json");
    return;
  }

  info(`=== Hooks changes to ${SETTINGS} ===`);
  console.log(diffText(
    sortedPrettyJson(settings) + "\n",
    sortedPrettyJson(filtered) + "\n",
  ));
  info("");

  if (await confirm()) {
    if (!DRY_RUN) {
      writeJsonFile(SETTINGS, filtered);
      manifestDeleteTarget("~/.claude/settings.json");
      info("Hooks removed from settings.json.");
    }
  } else {
    info("Skipped hooks uninstall.");
  }
}

// ---------------------------------------------------------------------------
// Uninstall launchd (macOS)
// ---------------------------------------------------------------------------
async function uninstallLaunchd() {
  if (!existsSync(PLIST) && !manifestTargetExists("~/Library/LaunchAgents/com.autonoma.scheduler.plist")) {
    return;
  }

  info("=== launchd changes ===");
  if (existsSync(PLIST)) info(`Will remove plist: ${PLIST}`);
  info(`Will unload launchd label: ${PLIST_LABEL}`);
  info("");

  if (await confirm()) {
    if (!DRY_RUN) {
      try { execSync(`launchctl bootout gui/$(id -u) "${PLIST}"`, { stdio: "pipe" }); } catch {}
      rmSync(PLIST, { force: true });
      manifestDeleteTarget("~/Library/LaunchAgents/com.autonoma.scheduler.plist");
      info("launchd scheduler removed.");
    }
  } else {
    info("Skipped launchd uninstall.");
  }
}

// ---------------------------------------------------------------------------
// Uninstall systemd (Linux)
// ---------------------------------------------------------------------------
function systemctlUserAvailable() {
  try {
    execSync("systemctl --user show-environment", { stdio: "pipe" });
    return true;
  } catch { return false; }
}

async function uninstallLinuxSystemd() {
  if (CURRENT_OS !== "Linux") return;

  if (!existsSync(SYSTEMD_SERVICE_DEST) && !existsSync(SYSTEMD_TIMER_DEST)
    && !manifestTargetExists("~/.config/systemd/user/autonoma-scheduler.service")
    && !manifestTargetExists("~/.config/systemd/user/autonoma-scheduler.timer")) {
    return;
  }

  info("=== systemd user scheduler changes ===");
  if (existsSync(SYSTEMD_SERVICE_DEST)) info(`Will remove unit: ${SYSTEMD_SERVICE_DEST}`);
  if (existsSync(SYSTEMD_TIMER_DEST)) info(`Will remove unit: ${SYSTEMD_TIMER_DEST}`);
  info(`Will disable/stop: ${SYSTEMD_TIMER_NAME}`);
  info("");

  if (await confirm()) {
    if (!DRY_RUN) {
      if (systemctlUserAvailable()) {
        try { execSync(`systemctl --user disable --now ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" }); } catch {}
        try { execSync(`systemctl --user reset-failed ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" }); } catch {}
        try { execSync(`systemctl --user reset-failed ${SYSTEMD_SERVICE_NAME}`, { stdio: "pipe" }); } catch {}
      } else {
        warn("systemd --user is unavailable; removing unit files without stopping the timer.");
      }
      rmSync(SYSTEMD_SERVICE_DEST, { force: true });
      rmSync(SYSTEMD_TIMER_DEST, { force: true });
      if (commandExists("systemctl")) {
        try { execSync("systemctl --user daemon-reload", { stdio: "pipe" }); } catch {}
      }
      manifestDeleteTarget("~/.config/systemd/user/autonoma-scheduler.service");
      manifestDeleteTarget("~/.config/systemd/user/autonoma-scheduler.timer");
      info("Linux systemd scheduler removed.");
    }
  } else {
    info("Skipped Linux systemd scheduler uninstall.");
  }
}

// ---------------------------------------------------------------------------
// Uninstall legacy crontab
// ---------------------------------------------------------------------------
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

async function uninstallLinuxLegacyCrontab() {
  if (!commandExists("crontab")) {
    if (manifestTargetExists(LEGACY_CRONTAB_TARGET)) {
      warn("crontab is unavailable; cannot remove legacy scheduler entry automatically.");
    }
    return;
  }

  let beforeText = "";
  try { beforeText = execSync("crontab -l", { encoding: "utf8" }); } catch { beforeText = ""; }

  if (!manifestTargetExists(LEGACY_CRONTAB_TARGET) && !beforeText.includes("# autonoma-scheduler")) {
    return;
  }

  const afterText = computeLegacyCrontabAfterText(beforeText);

  if (beforeText === afterText) {
    info("Legacy cron scheduler entry already absent.");
    if (!DRY_RUN) manifestDeleteTarget(LEGACY_CRONTAB_TARGET);
    return;
  }

  const beforeHash = beforeText ? sha256Text(beforeText) : "";

  info("=== Legacy crontab cleanup ===");
  console.log(diffText(beforeText + "\n", afterText + "\n"));
  info("");

  if (await confirm()) {
    if (!DRY_RUN) {
      applyLegacyCrontabText(afterText);
      const currentHash = afterText ? sha256Text(afterText) : "null";
      log(`INFO: Removed legacy crontab scheduler before=${beforeHash || "null"} after=${currentHash}`);
      manifestDeleteTarget(LEGACY_CRONTAB_TARGET);
      info("Legacy Linux cron scheduler removed.");
    }
  } else {
    info("Skipped legacy crontab cleanup.");
  }
}

// ---------------------------------------------------------------------------
// Uninstall web/.env
// ---------------------------------------------------------------------------
const AUTONOMA_ENV_KEYS = ["VITE_AUTONOMA_BASE_URL", "VITE_AUTONOMA_TOKEN"];
const WEB_ENV_MANIFEST_KEY = "web/.env";

function resolveProjectRoot() {
  const configPath = join(AUTONOMA_DIR, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = readJsonFile(configPath);
      if (config.projectRoot) return config.projectRoot;
    } catch {}
  }
  const sourceRootPath = join(AUTONOMA_DIR, "source-root");
  if (existsSync(sourceRootPath)) {
    const root = readFileSync(sourceRootPath, "utf8").trim();
    if (root) return root;
  }
  return "";
}

async function uninstallWebEnv() {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    if (manifestTargetExists(WEB_ENV_MANIFEST_KEY)) {
      warn("Cannot resolve project root to clean up web/.env. Clearing manifest entry.");
      if (!DRY_RUN) manifestDeleteTarget(WEB_ENV_MANIFEST_KEY);
    }
    return;
  }

  const webEnvPath = join(projectRoot, "web", ".env");
  if (!existsSync(webEnvPath) && !manifestTargetExists(WEB_ENV_MANIFEST_KEY)) return;

  if (!existsSync(webEnvPath)) {
    info("web/.env already absent.");
    if (!DRY_RUN) manifestDeleteTarget(WEB_ENV_MANIFEST_KEY);
    return;
  }

  const before = readFileSync(webEnvPath, "utf8");
  const afterLines = before.split("\n").filter((line) => {
    const key = line.split("=")[0].trim();
    return !AUTONOMA_ENV_KEYS.includes(key);
  });
  const after = afterLines.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");

  if (!after.trim()) {
    info("=== web/.env cleanup ===");
    info(`Will remove ${webEnvPath} (only contained Autonoma vars)`);
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        rmSync(webEnvPath, { force: true });
        manifestDeleteTarget(WEB_ENV_MANIFEST_KEY);
        info("Removed web/.env.");
      }
    } else {
      info("Skipped web/.env cleanup.");
    }
  } else if (before !== after) {
    info("=== web/.env cleanup ===");
    console.log(diffText(before, after));
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        atomicWrite(webEnvPath, after);
        manifestDeleteTarget(WEB_ENV_MANIFEST_KEY);
        info("Cleaned Autonoma vars from web/.env.");
      }
    } else {
      info("Skipped web/.env cleanup.");
    }
  } else {
    info("web/.env has no Autonoma vars to clean.");
    if (!DRY_RUN) manifestDeleteTarget(WEB_ENV_MANIFEST_KEY);
  }
}

// ---------------------------------------------------------------------------
// Uninstall scheduler (combined)
// ---------------------------------------------------------------------------
async function uninstallScheduler() {
  if (CURRENT_OS === "Darwin") {
    await uninstallLaunchd();
  } else if (CURRENT_OS === "Linux") {
    await uninstallLinuxSystemd();
    await uninstallLinuxLegacyCrontab();
  }
}

// ---------------------------------------------------------------------------
// Graceful stop
// ---------------------------------------------------------------------------
function gracefulStop() {
  const upScript = join(AUTONOMA_DIR, "bin", "autonoma-up");
  if (existsSync(upScript)) {
    if (DRY_RUN) {
      info(`(dry-run) Would stop Autonoma runtime via ${upScript} stop`);
    } else {
      try { execSync(`"${upScript}" stop`, { stdio: "pipe" }); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Uninstall runtime tree
// ---------------------------------------------------------------------------
async function uninstallRuntimeTree() {
  if (!REMOVE_RUNTIME) return;

  if (!existsSync(AUTONOMA_DIR)) {
    info("Autonoma runtime directory already absent.");
    return;
  }

  info("=== Runtime removal ===");
  info(`Will remove ${AUTONOMA_DIR} and all install-managed state:`);
  info("- runtime scripts and hooks");
  info("- staged src mirror");
  info("- config, manifest, blackboard DB, and logs");
  info("- WhatsApp auth and runtime files");
  info("");

  if (await confirm()) {
    gracefulStop();
    if (!DRY_RUN) {
      rmSync(AUTONOMA_DIR, { recursive: true, force: true });
      LOG_ENABLED = false;
      info(`Removed ${AUTONOMA_DIR}.`);
    }
  } else {
    info("Skipped runtime removal.");
  }
}

// ---------------------------------------------------------------------------
// Cleanup manifest if empty
// ---------------------------------------------------------------------------
function cleanupManifestIfEmpty() {
  if (!REMOVE_RUNTIME && !DRY_RUN && existsSync(MANIFEST)) {
    try {
      const manifest = readJsonFile(MANIFEST);
      const remaining = Object.keys(manifest.targets || {}).length;
      if (remaining === 0) {
        rmSync(MANIFEST, { force: true });
        info("Manifest cleared (no remaining external targets).");
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  ensurePrereqs();

  info("Autonoma Uninstaller");
  info("====================");
  if (DRY_RUN) info("(dry-run mode — no changes will be written)");
  info("");

  await uninstallHooks();
  await uninstallWebEnv();
  await uninstallScheduler();
  cleanupManifestIfEmpty();
  await uninstallRuntimeTree();

  info("Uninstall complete.");
}

main().catch((e) => {
  error(`Uninstall failed: ${e.message}`);
  process.exit(1);
});
