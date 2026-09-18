import fs from 'node:fs';
import { createLinearProvider, emptyLinearInboundStats } from './linear-provider.mjs';
import { createTodoistProvider, emptyTodoistInboundStats } from './todoist-provider.mjs';

const installedAccess = new URL('../../../scripts/config-access.mjs', import.meta.url);
const { readConfiguration } = await import(fs.existsSync(installedAccess) ? installedAccess.href : new URL('../../../installer/scripts/config-access.mjs', import.meta.url).href);

export async function loadIntegrations() {
  const raw = await readConfiguration();
  const todoistApiKey = configString(raw.todoistApiKey);
  const linearApiKey = configString(raw.linearApiKey);
  return {
    ...(todoistApiKey ? { todoist: { apiKey: todoistApiKey } } : {}),
    ...(linearApiKey ? { linear: { apiKey: linearApiKey } } : {}),
  };
}

export async function configuredProviders(deps) {
  const integrations = await loadIntegrations();
  return [
    ...(integrations.todoist ? [createTodoistProvider(integrations.todoist, deps)] : []),
    ...(integrations.linear ? [createLinearProvider(integrations.linear, deps)] : []),
  ];
}

export async function syncTodoistIntegration(store, idx, input, deps) {
  const integrations = await loadIntegrations();
  if (!integrations.todoist) return { skipped: true, reason: 'no_api_key', direction: 'inbound', inbound: emptyTodoistInboundStats() };
  return createTodoistProvider(integrations.todoist, deps).syncIn(store, idx, input);
}

export async function syncLinearIntegration(store, idx, input, deps) {
  const integrations = await loadIntegrations();
  if (!integrations.linear) return { skipped: true, reason: 'no_api_key', direction: 'inbound', inbound: emptyLinearInboundStats() };
  return createLinearProvider(integrations.linear, deps).syncIn(store, idx, input);
}

function configString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
