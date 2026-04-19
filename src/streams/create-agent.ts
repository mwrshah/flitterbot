import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { FlitterbotConfig, ThinkingLevel } from "../config/load-config.ts";
import { resolveModelEntry } from "../config/models.ts";
import type { OrchestratorContext } from "../prompts/index.ts";
import { buildDefaultAgentPrompt, buildOrchestratorSoloPrompt } from "../prompts/index.ts";

/**
 * Orchestrator context as provided by the caller. `piSessionId` and `cwd` are
 * injected internally by this module — piSessionId from the freshly-created or
 * resumed SessionManager, cwd from the effective working directory.
 */
type OrchestratorInput = Omit<OrchestratorContext, "piSessionId" | "cwd">;

const HOME = os.homedir();

type StreamsRole = "default" | "orchestrator";

/**
 * Custom tools use plain JSON Schema objects for `parameters` (not TypeBox TSchema),
 * so we accept a loose array and cast to ToolDefinition[] at the SDK boundary.
 */
type CreateFlitterbotAgentOptions = {
  config: FlitterbotConfig;
  customTools: unknown[];
  role?: StreamsRole;
  orchestratorContext?: OrchestratorInput;
  /** When set, resume an existing session from this JSONL file instead of creating a new one. */
  resumeSessionFile?: string;
  /** Override the working directory (e.g. a specific repo root). Defaults to config.projectsDir. */
  cwd?: string;
  /** Override the model for this session. When omitted, falls back to `config.defaultModel`. */
  modelId?: string;
};

export async function createFlitterbotAgent(options: CreateFlitterbotAgentOptions) {
  const {
    config,
    customTools,
    role = "default",
    orchestratorContext,
    resumeSessionFile,
    cwd,
  } = options;
  const workingDir = cwd ?? config.projectsDir;

  // If resuming an existing session, open its JSONL file to preserve the piSessionId
  // and conversation history. Otherwise create a fresh session.
  const sessionManager = resumeSessionFile
    ? SessionManager.open(resumeSessionFile, config.controlSurfaceSessionsDir)
    : SessionManager.create(workingDir, config.controlSurfaceSessionsDir);
  const piSessionId = sessionManager.getSessionId();

  const systemPrompt = resolveSystemPrompt(
    role,
    piSessionId,
    workingDir,
    orchestratorContext,
    config.projectsDir,
  );
  // Mutable ref so the systemPromptOverride closure always reads the final prompt.
  // Each agent gets its own ref — no shared file read — which fixes the
  // concurrent-orchestrator race condition.
  const promptRef = { value: systemPrompt };

  // Use the canonical Pi auth — same OAuth tokens the Pi CLI uses after `pi auth login`.
  const piAuthPath = path.join(HOME, ".pi", "agent", "auth.json");
  const authPath = fs.existsSync(piAuthPath)
    ? piAuthPath
    : path.join(config.controlSurfaceAgentDir, "auth.json");
  const authStorage = AuthStorage.create(authPath);
  // Use the control-surface agent dir so the resource loader doesn't pick up
  // ~/.pi/agent skills or AGENTS.md. Auth and models still resolve from
  // ~/.pi/agent explicitly (same pattern as authStorage above).
  const agentDir = config.controlSurfaceAgentDir;
  const piModelsPath = path.join(HOME, ".pi", "agent", "models.json");
  const modelsPath = fs.existsSync(piModelsPath)
    ? piModelsPath
    : path.join(agentDir, "models.json");
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const settingsManager = SettingsManager.inMemory();
  // Skill paths, in precedence order:
  //   1. Built-in user-level dirs (`~/.claude/skills`, `~/.agents/skills`)
  //   2. `extraSkillPaths` from ~/.flitterbot/config.json, in declared order
  // The loader de-duplicates by skill name — first occurrence wins — so
  // built-ins cannot be shadowed by extras. Collisions surface via
  // resourceLoader.getSkills().diagnostics and are logged below.
  const builtInSkillPaths = [
    path.join(HOME, ".claude", "skills"),
    path.join(HOME, ".agents", "skills"),
  ];
  const skillPathWarnings: string[] = [];
  const extraSkillPaths: string[] = [];
  for (const entry of config.extraSkillPaths) {
    if (!fs.existsSync(entry)) {
      skillPathWarnings.push(`extraSkillPaths: missing directory skipped: ${entry}`);
      continue;
    }
    extraSkillPaths.push(entry);
  }
  const additionalSkillPaths = [
    ...builtInSkillPaths.filter((entry) => fs.existsSync(entry)),
    ...extraSkillPaths,
  ];

  const resourceLoader = new DefaultResourceLoader({
    cwd: workingDir,
    agentDir,
    settingsManager,
    additionalSkillPaths,
    systemPromptOverride: () => promptRef.value,
  });
  await resourceLoader.reload();

  // Collect resource info for startup logging
  const { skills, diagnostics: skillDiagnostics } = resourceLoader.getSkills();
  const { agentsFiles } = resourceLoader.getAgentsFiles();
  const skillNames = skills.map((s) => s.name);
  const agentsFilePaths = agentsFiles.map((f) => f.path);
  // Surface collision / missing-path diagnostics from the loader so the
  // orchestrator log clearly shows which skills were shadowed and which
  // extra paths were silently dropped.
  const skillMessages: string[] = [...skillPathWarnings];
  for (const d of skillDiagnostics) {
    if (d.type === "collision" && d.collision) {
      skillMessages.push(
        `skill name collision: "${d.collision.name}" — keeping ${d.collision.winnerPath}, ignoring ${d.collision.loserPath}`,
      );
    } else if (d.type === "warning" || d.type === "error") {
      skillMessages.push(`skill ${d.type}: ${d.message}${d.path ? ` (${d.path})` : ""}`);
    }
  }

  const modelEntry = resolveModelEntry(config, options.modelId);
  const model = getModel(
    modelEntry.provider as Parameters<typeof getModel>[0],
    modelEntry.modelId as Parameters<typeof getModel>[1],
  );
  if (!model) {
    throw new Error(
      `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId} (entry id=${modelEntry.id})`,
    );
  }
  const effectiveThinkingLevel: ThinkingLevel = modelEntry.thinkingLevel ?? config.piThinkingLevel;

  const created = await createAgentSession({
    cwd: workingDir,
    agentDir,
    model,
    thinkingLevel: effectiveThinkingLevel,
    tools: createCodingTools(workingDir),
    customTools: customTools as ToolDefinition[],
    resourceLoader,
    sessionManager,
    settingsManager,
    authStorage,
    modelRegistry,
  });

  return {
    ...created,
    modelInfo: {
      provider: model.provider,
      id: model.id,
      entryId: modelEntry.id,
      thinkingLevel: effectiveThinkingLevel,
    },
    resourceInfo: {
      skillNames,
      agentsFilePaths,
      skillMessages,
    },
  };
}

function resolveSystemPrompt(
  role: StreamsRole,
  piSessionId: string,
  cwd: string,
  ctx?: OrchestratorInput,
  projectsDir?: string,
): string {
  if (role === "orchestrator") {
    if (!ctx) throw new Error("orchestratorContext is required for orchestrator role");
    return buildOrchestratorSoloPrompt({ ...ctx, piSessionId, cwd });
  }
  return buildDefaultAgentPrompt(piSessionId, projectsDir ?? cwd);
}
