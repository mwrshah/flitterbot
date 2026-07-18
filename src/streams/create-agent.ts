import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { FlitterbotConfig } from "../config/load-config.ts";
import { resolveModelEntry, resolveModelEntryId } from "../config/models.ts";
import { createPiAuthStorage, createPiModelRegistry } from "../pi-auth.ts";
import type { OrchestratorContext } from "../prompts/index.ts";
import { buildDefaultAgentPrompt, buildOrchestratorPrompt } from "../prompts/index.ts";

type OrchestratorInput = Omit<OrchestratorContext, "piSessionId" | "cwd">;

const HOME = os.homedir();

// Pi's coding-agent layer does not expose cacheRetention, so use its documented provider setting.
process.env.PI_CACHE_RETENTION = "long";

type StreamsRole = "default" | "orchestrator";

type CreateFlitterbotAgentOptions = {
  config: FlitterbotConfig;
  customTools: unknown[];
  role: StreamsRole;
  orchestratorContext?: OrchestratorInput;
  resumeSessionFile?: string;
  cwd?: string;
};

export async function createFlitterbotAgent(options: CreateFlitterbotAgentOptions) {
  const { config, customTools, role, orchestratorContext, resumeSessionFile, cwd } = options;
  const workingDir = cwd ?? config.projectsDir;

  const sessionManager = resumeSessionFile
    ? SessionManager.open(resumeSessionFile, config.controlSurfaceSessionsDir)
    : SessionManager.create(workingDir, config.controlSurfaceSessionsDir);

  const authStorage = createPiAuthStorage(config.controlSurfaceAgentDir);
  const agentDir = config.controlSurfaceAgentDir;
  const modelRegistry = createPiModelRegistry(authStorage, agentDir);
  const settingsManager = SettingsManager.inMemory({
    compaction: { keepRecentTokens: 12_000 },
  });
  settingsManager.setTransport(config.piTransport);
  const builtInSkillPaths = [
    path.join(HOME, ".claude", "skills"),
    path.join(HOME, ".agents", "skills"),
  ];
  const resourceMessages: string[] = [];
  const additionalSkillPaths: string[] = [];
  if (fs.existsSync(config.flitterbotSkillsDir)) {
    additionalSkillPaths.push(config.flitterbotSkillsDir);
  } else {
    resourceMessages.push(`bundled skills directory missing: ${config.flitterbotSkillsDir}`);
  }
  additionalSkillPaths.push(...builtInSkillPaths.filter((entry) => fs.existsSync(entry)));
  for (const entry of config.extraSkillPaths) {
    if (fs.existsSync(entry)) {
      additionalSkillPaths.push(entry);
    } else {
      resourceMessages.push(`extraSkillPaths: missing directory skipped: ${entry}`);
    }
  }

  const homeAgentsMdPath = path.join(HOME, ".agents", "AGENTS.md");
  let homeAgentsMdEntry: { path: string; content: string } | null = null;
  try {
    if (fs.existsSync(homeAgentsMdPath)) {
      homeAgentsMdEntry = {
        path: homeAgentsMdPath,
        content: fs.readFileSync(homeAgentsMdPath, "utf-8"),
      };
    }
  } catch (err) {
    resourceMessages.push(
      `failed to read ${homeAgentsMdPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const modelEntry = resumeSessionFile ? undefined : resolveModelEntry(config);
  const model = modelEntry
    ? getBuiltinModel(modelEntry.provider as KnownProvider, modelEntry.modelId as never)
    : undefined;
  if (modelEntry && !model) {
    throw new Error(
      `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId} (entry id=${modelEntry.id})`,
    );
  }
  const effectiveThinkingLevel = modelEntry
    ? (modelEntry.thinkingLevel ?? config.defaultThinkingLevel)
    : undefined;

  const runtimeFactory: CreateAgentSessionRuntimeFactory = async (factoryOpts) => {
    const piSessionId = factoryOpts.sessionManager.getSessionId();
    const systemPrompt =
      role === "orchestrator"
        ? buildOrchestratorPrompt(
            {
              ...requireOrchestratorContext(orchestratorContext),
              piSessionId,
              cwd: factoryOpts.cwd,
            },
            { tmux: config.tmuxEnabled },
          )
        : buildDefaultAgentPrompt(piSessionId, config.projectsDir);

    const services = await createAgentSessionServices({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      resourceLoaderOptions: {
        additionalSkillPaths,
        appendSystemPromptOverride: (base) => [...base, systemPrompt],
        agentsFilesOverride: (baseAgents) => {
          if (!homeAgentsMdEntry) return baseAgents;
          const already = baseAgents.agentsFiles.some((f) => f.path === homeAgentsMdEntry?.path);
          if (already) return baseAgents;
          return {
            agentsFiles: [homeAgentsMdEntry, ...baseAgents.agentsFiles],
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

  const resourceLoader = runtime.services.resourceLoader;
  const { skills, diagnostics: skillDiagnostics } = resourceLoader.getSkills();
  const { agentsFiles } = resourceLoader.getAgentsFiles();
  resourceMessages.push(
    skills.length > 0
      ? `loaded ${skills.length} skills: ${skills.map((skill) => skill.name).join(", ")}`
      : "no skills loaded",
    ...skillDiagnostics.flatMap((diagnostic) => {
      if (diagnostic.type === "collision" && diagnostic.collision) {
        return `skill name collision: "${diagnostic.collision.name}" — keeping ${diagnostic.collision.winnerPath}, ignoring ${diagnostic.collision.loserPath}`;
      }
      return diagnostic.type === "warning" || diagnostic.type === "error"
        ? `skill ${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`
        : [];
    }),
    ...agentsFiles.map((file) => `loaded ${path.basename(file.path)} from ${file.path}`),
  );

  const currentModel = runtime.session.model;
  if (!currentModel) {
    throw new Error("Pi session started without a resolved model");
  }
  return {
    runtime,
    modelInfo: {
      provider: currentModel.provider,
      id: currentModel.id,
      entryId: resolveModelEntryId(config, currentModel.provider, currentModel.id),
      thinkingLevel: runtime.session.thinkingLevel,
    },
    resourceMessages,
  };
}

function requireOrchestratorContext(context?: OrchestratorInput): OrchestratorInput {
  if (!context) throw new Error("orchestratorContext is required for orchestrator role");
  return context;
}
