import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createGrepTool,
  createReadTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AutonomaConfig } from "../config/load-config.ts";
import type { OrchestratorContext } from "../prompts/index.ts";
import { buildDefaultAgentPrompt, buildOrchestratorPrompt } from "../prompts/index.ts";

/** Orchestrator context as provided by the caller — piSessionId is injected internally. */
type OrchestratorInput = Omit<OrchestratorContext, "piSessionId">;

const HOME = os.homedir();

type PiRole = "default" | "orchestrator";

type CreateAutonomaAgentOptions = {
  config: AutonomaConfig;
  customTools: ToolDefinition[];
  role?: PiRole;
  orchestratorContext?: OrchestratorInput;
};

export async function createAutonomaAgent(options: CreateAutonomaAgentOptions) {
  const { config, customTools, role = "default", orchestratorContext } = options;
  const workingDir = config.projectsDir;

  // Create SessionManager early so we can read the piSessionId before building the prompt.
  // SessionManager generates its sessionId in the constructor (via newSession()),
  // and createAgentSession reuses this same instance — so the IDs match.
  const sessionManager = SessionManager.create(workingDir, config.controlSurfaceSessionsDir);
  const piSessionId = sessionManager.getSessionId();

  const systemPrompt = resolveSystemPrompt(role, piSessionId, orchestratorContext);
  ensurePromptFile(config.controlSurfacePromptPath, systemPrompt);
  // Use the canonical Pi auth — same OAuth tokens the Pi CLI uses after `pi auth login`.
  // ~/.autonoma/control-surface/agent/auth.json is symlinked here, but if someone
  // breaks the symlink we still resolve to the right place.
  const piAuthPath = path.join(HOME, ".pi", "agent", "auth.json");
  const authPath = fs.existsSync(piAuthPath)
    ? piAuthPath
    : path.join(config.controlSurfaceAgentDir, "auth.json");
  const authStorage = AuthStorage.create(authPath);
  // Use ~/.pi/agent as the agent dir — same as the Pi CLI. This picks up
  // AGENTS.md, models.json, and any agent-level config from the canonical location
  // instead of a separate ~/.autonoma/control-surface/agent/ silo.
  const piAgentDir = path.join(HOME, ".pi", "agent");
  const agentDir = fs.existsSync(piAgentDir) ? piAgentDir : config.controlSurfaceAgentDir;

  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: workingDir,
    agentDir,
    settingsManager,
    additionalSkillPaths: [path.join(HOME, ".agents", "skills")].filter((entry) =>
      fs.existsSync(entry),
    ),
    systemPromptOverride: () => fs.readFileSync(config.controlSurfacePromptPath, "utf8"),
  });
  await resourceLoader.reload();

  const model = getModel("anthropic", config.piModel as Parameters<typeof getModel>[1]);
  if (!model) {
    throw new Error(`Unable to resolve Pi model: ${config.piModel}`);
  }

  const created = await createAgentSession({
    cwd: workingDir,
    agentDir,
    model,
    thinkingLevel: config.piThinkingLevel,
    tools: [createReadTool(workingDir), createBashTool(workingDir), createGrepTool(workingDir)],
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager,
    authStorage,
    modelRegistry,
  });

  return {
    ...created,
    modelInfo: {
      provider: (model as any).providerId ?? (model as any).provider ?? "anthropic",
      id: (model as any).modelId ?? (model as any).id ?? config.piModel,
    },
  };
}

function resolveSystemPrompt(role: PiRole, piSessionId: string, ctx?: OrchestratorInput): string {
  if (role === "orchestrator") {
    if (!ctx) throw new Error("orchestratorContext is required for orchestrator role");
    return buildOrchestratorPrompt({ ...ctx, piSessionId });
  }
  return buildDefaultAgentPrompt(piSessionId);
}

function ensurePromptFile(promptPath: string, content: string): void {
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, content, "utf8");
}
