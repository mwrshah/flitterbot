import fs from "node:fs";
import { createLinearProvider, emptyLinearInboundStats } from "./linear-provider.mjs";
import { createTodoistProvider, emptyTodoistInboundStats } from "./todoist-provider.mjs";

export function loadIntegrations(configPath) {
  if (!fs.existsSync(configPath)) return {};
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const todoistApiKey = configString(raw.todoistApiKey);
  const linearApiKey = configString(raw.linearApiKey);
  return {
    ...(todoistApiKey ? { todoist: { apiKey: todoistApiKey } } : {}),
    ...(linearApiKey ? { linear: { apiKey: linearApiKey } } : {}),
  };
}

export function configuredProviders(configPath, deps) {
  const integrations = loadIntegrations(configPath);
  return [
    ...(integrations.todoist ? [createTodoistProvider(integrations.todoist, deps)] : []),
    ...(integrations.linear ? [createLinearProvider(integrations.linear, deps)] : []),
  ];
}

export async function syncTodoistIntegration(configPath, store, idx, input, deps) {
  const integrations = loadIntegrations(configPath);
  if (!integrations.todoist) return { skipped: true, reason: "no_api_key", direction: "inbound", inbound: emptyTodoistInboundStats() };
  return createTodoistProvider(integrations.todoist, deps).syncIn(store, idx, input);
}

export async function syncLinearIntegration(configPath, store, idx, input, deps) {
  const integrations = loadIntegrations(configPath);
  if (!integrations.linear) return { skipped: true, reason: "no_api_key", direction: "inbound", inbound: emptyLinearInboundStats() };
  return createLinearProvider(integrations.linear, deps).syncIn(store, idx, input);
}

function configString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
