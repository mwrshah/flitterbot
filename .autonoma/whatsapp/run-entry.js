#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const autonomaHome = process.env.AUTONOMA_HOME || path.join(os.homedir(), '.autonoma');
const configPath = path.join(autonomaHome, 'config.json');
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function resolveEntry(entryName) {
  const config = readConfig();
  const configuredRoot = typeof config.projectRoot === 'string' && config.projectRoot
    ? config.projectRoot
    : typeof config.sourceRoot === 'string' && config.sourceRoot
      ? config.sourceRoot
      : undefined;

  if (configuredRoot) {
    const src = path.join(configuredRoot, 'src', 'whatsapp', `${entryName}.ts`);
    if (existsSync(src)) {
      return ['--experimental-strip-types', src];
    }
  }

  const repoRelativeSrc = path.resolve(runtimeDir, '..', '..', 'src', 'whatsapp', `${entryName}.ts`);
  if (existsSync(repoRelativeSrc)) {
    return ['--experimental-strip-types', repoRelativeSrc];
  }

  const localSrc = path.join(autonomaHome, 'src', 'whatsapp', `${entryName}.ts`);
  if (existsSync(localSrc)) {
    return ['--experimental-strip-types', localSrc];
  }

  throw new Error(`Unable to locate WhatsApp ${entryName} entrypoint.`);
}

export function runWhatsAppEntry(entryName, args) {
  const child = spawn(process.execPath, [...resolveEntry(entryName), ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
