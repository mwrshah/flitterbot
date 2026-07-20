import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
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
import { createFlitterbotExtension, type FlitterbotTool } from "./flitterbot-extension.ts";

type OrchestratorInput = Omit<OrchestratorContext, "piSessionId" | "cwd">;

const HOME = os.homedir();

// Pi's coding-agent layer does not expose cacheRetention, so use its documented provider setting.
process.env.PI_CACHE_RETENTION = "long";

type StreamsRole = "default" | "orchestrator";

type CreateFlitterbotAgentOptions = {
  config: FlitterbotConfig;
  customTools: FlitterbotTool[];
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

  const authStorage = createPiAuthStorage();
  const agentDir = config.piAgentDir;
  const modelRegistry = createPiModelRegistry(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { keepRecentTokens: 12_000 },
  });
  settingsManager.setTransport(config.piTransport);
  const builtInSkillPaths = [path.join(HOME, ".claude", "skills")];
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
    const rolePrompt =
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

    const memory = readMemory(config.memoryPath);
    const services = await createAgentSessionServices({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      resourceLoaderOptions: {
        extensionFactories: [createFlitterbotExtension(customTools, additionalSkillPaths)],
        appendSystemPromptOverride: (base) => [rolePrompt, ...(memory ? [memory] : []), ...base],
      },
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager: factoryOpts.sessionManager,
      sessionStartEvent: factoryOpts.sessionStartEvent,
      ...(model ? { model } : {}),
      ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
    });

    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(runtimeFactory, {
    cwd: workingDir,
    agentDir,
    sessionManager,
  });

  const bindExtensions = async (session: typeof runtime.session) => {
    await session.bindExtensions({ mode: "print" });
  };
  runtime.setRebindSession(bindExtensions);
  await bindExtensions(runtime.session);

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

function readMemory(memoryPath: string): string {
  try {
    return fs.readFileSync(memoryPath, "utf8").trim();
  } catch (error) {
    throw new Error(
      `Unable to read Flitterbot memory at ${memoryPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireOrchestratorContext(context?: OrchestratorInput): OrchestratorInput {
  if (!context) throw new Error("orchestratorContext is required for orchestrator role");
  return context;
}
