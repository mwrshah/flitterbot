import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { FlitterbotConfig, ThinkingLevel } from "../config/load-config.ts";
import { resolveModelEntry } from "../config/models.ts";
import { createPiAuthStorage, createPiModelRegistry } from "../pi-auth.ts";
import type { OrchestratorContext } from "../prompts/index.ts";
import { buildDefaultAgentPrompt, buildOrchestratorPrompt } from "../prompts/index.ts";

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
  /** Enable the tmux sub-agent section in the orchestrator prompt. Defaults to false. */
  tmuxEnabled?: boolean;
};

export type CreateFlitterbotAgentResult = {
  runtime: AgentSessionRuntime;
  modelInfo: {
    provider: string;
    id: string;
    entryId: string;
    thinkingLevel: ThinkingLevel;
  };
  resourceInfo: {
    skillNames: string[];
    agentsFilePaths: string[];
    skillMessages: string[];
  };
};

export async function createFlitterbotAgent(
  options: CreateFlitterbotAgentOptions,
): Promise<CreateFlitterbotAgentResult> {
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

  // Mutable ref so the appendSystemPromptOverride closure always reads the final
  // Flitterbot instructions. Each agent gets its own ref — no shared file read —
  // which fixes the concurrent-orchestrator race condition. Updated inside the
  // factory on each session creation to keep the piSessionId in sync.
  const promptRef = { value: "" };

  const authStorage = createPiAuthStorage(config.controlSurfaceAgentDir);
  // Use the control-surface agent dir so the resource loader doesn't pick up
  // ~/.pi/agent skills or AGENTS.md. Auth and models still resolve from
  // ~/.pi/agent explicitly. The user-level ~/.agents/AGENTS.md is injected
  // separately below via agentsFilesOverride so both default and orchestrator
  // sessions always see it regardless of cwd.
  const agentDir = config.controlSurfaceAgentDir;
  const modelRegistry = createPiModelRegistry(authStorage, agentDir);
  const settingsManager = SettingsManager.inMemory();
  settingsManager.setTransport(config.piTransport);
  // Skill paths, in precedence order:
  //   1. Bundled Flitterbot skills (`~/.flitterbot/skills`)
  //   2. Built-in user-level dirs (`~/.claude/skills`, `~/.agents/skills`)
  //   3. `extraSkillPaths` from ~/.flitterbot/config.json, in declared order
  // The loader de-duplicates by skill name — first occurrence wins — so
  // bundled skills cannot be shadowed by user-level or extra paths. Collisions
  // surface via resourceLoader.getSkills().diagnostics and are logged below.
  const builtInSkillPaths = [
    path.join(HOME, ".claude", "skills"),
    path.join(HOME, ".agents", "skills"),
  ];
  const skillPathWarnings: string[] = [];
  const additionalSkillPaths: string[] = [];
  if (fs.existsSync(config.flitterbotSkillsDir)) {
    additionalSkillPaths.push(config.flitterbotSkillsDir);
  } else {
    skillPathWarnings.push(`bundled skills directory missing: ${config.flitterbotSkillsDir}`);
  }
  additionalSkillPaths.push(...builtInSkillPaths.filter((entry) => fs.existsSync(entry)));
  for (const entry of config.extraSkillPaths) {
    if (fs.existsSync(entry)) {
      additionalSkillPaths.push(entry);
    } else {
      skillPathWarnings.push(`extraSkillPaths: missing directory skipped: ${entry}`);
    }
  }

  // Load ~/.agents/AGENTS.md once at factory-construction time. This is the
  // user's global agent instructions file — essential context that must be
  // present for every Flitterbot session (default + orchestrator) regardless
  // of cwd or which agentDir the resource loader scans.
  const userAgentsMdPath = path.join(HOME, ".agents", "AGENTS.md");
  let userAgentsMdEntry: { path: string; content: string } | null = null;
  try {
    if (fs.existsSync(userAgentsMdPath)) {
      userAgentsMdEntry = {
        path: userAgentsMdPath,
        content: fs.readFileSync(userAgentsMdPath, "utf-8"),
      };
    }
  } catch (err) {
    skillPathWarnings.push(
      `failed to read ${userAgentsMdPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const shouldLetSessionRestoreModel = Boolean(resumeSessionFile) && !options.modelId;
  const modelEntry = shouldLetSessionRestoreModel
    ? undefined
    : resolveModelEntry(config, options.modelId);
  const model = modelEntry
    ? getModel(
        modelEntry.provider as Parameters<typeof getModel>[0],
        modelEntry.modelId as Parameters<typeof getModel>[1],
      )
    : undefined;
  if (modelEntry && !model) {
    throw new Error(
      `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId} (entry id=${modelEntry.id})`,
    );
  }
  const effectiveThinkingLevel: ThinkingLevel | undefined = modelEntry
    ? (modelEntry.thinkingLevel ?? config.defaultThinkingLevel)
    : undefined;

  // Build the factory that createAgentSessionRuntime stores and reuses for newSession().
  // Closes over config-derived values (auth, model, tools, prompts); receives per-session
  // cwd/agentDir/sessionManager from the runtime. Resume without an explicit model lets
  // the SDK restore the current model from the session JSONL model_change history.
  const runtimeFactory: CreateAgentSessionRuntimeFactory = async (factoryOpts) => {
    // Update the system prompt with the current session's piSessionId
    const factoryPiSessionId = factoryOpts.sessionManager.getSessionId();
    promptRef.value = resolveSystemPrompt(
      role,
      factoryPiSessionId,
      factoryOpts.cwd,
      orchestratorContext,
      config.projectsDir,
      options.tmuxEnabled ?? false,
    );

    const services = await createAgentSessionServices({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      resourceLoaderOptions: {
        additionalSkillPaths,
        appendSystemPromptOverride: (base) => [...base, promptRef.value],
        // Prepend ~/.agents/AGENTS.md to the context files the SDK passes into
        // the system prompt. De-duped by path so a re-scan that happens to
        // include it (e.g. cwd ancestor walk) doesn't double-inject.
        agentsFilesOverride: (baseAgents) => {
          if (!userAgentsMdEntry) return baseAgents;
          const already = baseAgents.agentsFiles.some((f) => f.path === userAgentsMdEntry?.path);
          if (already) return baseAgents;
          return {
            agentsFiles: [userAgentsMdEntry, ...baseAgents.agentsFiles],
          };
        },
      },
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager: factoryOpts.sessionManager,
      sessionStartEvent: factoryOpts.sessionStartEvent,
      ...(model ? { model } : {}),
      ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
      customTools: customTools as ToolDefinition[],
    });

    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(runtimeFactory, {
    cwd: workingDir,
    agentDir,
    sessionManager,
  });

  // Collect resource info for startup logging from the runtime's resource loader
  const resourceLoader = runtime.services.resourceLoader;
  const { skills, diagnostics: skillDiagnostics } = resourceLoader.getSkills();
  const { agentsFiles } = resourceLoader.getAgentsFiles();
  const skillNames = skills.map((s) => s.name);
  const agentsFilePaths = agentsFiles.map((f) => f.path);
  // Surface collision / warning diagnostics from the loader so the
  // orchestrator log clearly shows which skill paths were loaded.
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

  const currentModel = runtime.session.model;
  if (!currentModel) {
    throw new Error("Pi session started without a resolved model");
  }
  const currentThinkingLevel = runtime.session.thinkingLevel;

  return {
    runtime,
    modelInfo: {
      provider: currentModel.provider,
      id: currentModel.id,
      entryId: resolveModelEntryId(config, currentModel.provider, currentModel.id),
      thinkingLevel: currentThinkingLevel,
    },
    resourceInfo: {
      skillNames,
      agentsFilePaths,
      skillMessages,
    },
  };
}

function resolveModelEntryId(config: FlitterbotConfig, provider: string, modelId: string): string {
  return (
    config.models.find((entry) => entry.provider === provider && entry.modelId === modelId)?.id ??
    `${provider}/${modelId}`
  );
}

function resolveSystemPrompt(
  role: StreamsRole,
  piSessionId: string,
  cwd: string,
  ctx?: OrchestratorInput,
  projectsDir?: string,
  tmuxEnabled = false,
): string {
  if (role === "orchestrator") {
    if (!ctx) throw new Error("orchestratorContext is required for orchestrator role");
    return buildOrchestratorPrompt({ ...ctx, piSessionId, cwd }, { tmux: tmuxEnabled });
  }
  return buildDefaultAgentPrompt(piSessionId, projectsDir ?? cwd);
}
