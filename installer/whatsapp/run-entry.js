#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readConfiguration } from '../scripts/config-access.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const flitterbotHome = process.env.FLITTERBOT_HOME || path.join(os.homedir(), '.flitterbot');
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

async function resolveEntry(entryName) {
  const config = await readConfiguration();
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

  const localSrc = path.join(flitterbotHome, 'src', 'whatsapp', `${entryName}.ts`);
  if (existsSync(localSrc)) {
    return ['--experimental-strip-types', localSrc];
  }

  throw new Error(`Unable to locate WhatsApp ${entryName} entrypoint.`);
}

export async function runWhatsAppEntry(entryName, args) {
  const child = spawn(process.execPath, [...await resolveEntry(entryName), ...args], {
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
