import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createGrepToolDefinition,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/load-config.ts";
import { resolveModelEntry, resolveModelEntryId } from "../config/models.ts";
import { createPiModelRuntime } from "../pi-auth.ts";
import type { OrchestratorContext } from "../prompts/index.ts";
import { buildDefaultAgentPrompt, buildOrchestratorPrompt } from "../prompts/index.ts";
import { createFlitterbotExtension, type FlitterbotTool } from "./flitterbot-extension.ts";

type OrchestratorInput = Omit<OrchestratorContext, "piSessionId" | "cwd">;

const HOME = os.homedir();
const GREP_DEFAULT_LIMIT = 300;

process.env.PI_CACHE_RETENTION = "long";

type StreamsRole = "default" | "orchestrator";

type CreateFlitterbotAgentOptions = {
  customTools: FlitterbotTool[];
  role: StreamsRole;
  orchestratorContext?: OrchestratorInput;
  resumeSessionFile?: string;
  expectedPiSessionId?: string;
  cwd?: string;
};

export function readPiSessionHeaderId(sessionFile: string): string {
  const maxHeaderBytes = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(maxHeaderBytes);
  const descriptor = fs.openSync(sessionFile, "r");
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
  if (newline === -1 && bytesRead === maxHeaderBytes) {
    throw new Error(`Session file header exceeds ${maxHeaderBytes} bytes: ${sessionFile}`);
  }
  const firstLine = buffer.subarray(0, newline === -1 ? bytesRead : newline).toString("utf8");
  if (!firstLine.trim()) throw new Error(`Session file has no header: ${sessionFile}`);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(firstLine) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Session file has an invalid JSON header: ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (header.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw new Error(`Session file header is not a valid Pi session: ${sessionFile}`);
  }
  return header.id;
}

function validateStreamResumeFile(
  sessionFile: string,
  sessionsDir: string,
  expectedPiSessionId: string,
): void {
  const resolvedFile = path.resolve(sessionFile);
  if (path.dirname(resolvedFile) !== path.resolve(sessionsDir)) {
    throw new Error(`Stream session file must be restored before activation: ${sessionFile}`);
  }
  if (!fs.existsSync(resolvedFile)) {
    throw new Error(`Stream session file does not exist: ${sessionFile}`);
  }
  const headerPiSessionId = readPiSessionHeaderId(resolvedFile);
  if (headerPiSessionId !== expectedPiSessionId) {
    throw new Error(
      `Stream session file identity mismatch: expected ${expectedPiSessionId}, found ${headerPiSessionId}`,
    );
  }
}

export async function createFlitterbotAgent(options: CreateFlitterbotAgentOptions) {
  const { customTools, role, orchestratorContext, resumeSessionFile, expectedPiSessionId, cwd } =
    options;
  const initialConfig = loadConfig();
  const workingDir = cwd ?? initialConfig.projectsDir;

  if (expectedPiSessionId) {
    if (!resumeSessionFile) {
      throw new Error(`Pi session ${expectedPiSessionId} has no materialized session file`);
    }
    validateStreamResumeFile(
      resumeSessionFile,
      initialConfig.controlSurfaceSessionsDir,
      expectedPiSessionId,
    );
  }

  const sessionManager = resumeSessionFile
    ? SessionManager.open(resumeSessionFile, initialConfig.controlSurfaceSessionsDir)
    : SessionManager.create(workingDir, initialConfig.controlSurfaceSessionsDir);

  const agentDir = initialConfig.piAgentDir;
  let resourceMessages: string[] = [];

  const runtimeFactory: CreateAgentSessionRuntimeFactory = async (factoryOpts) => {
    const config = loadConfig();
    const modelRuntime = await createPiModelRuntime(config.controlSurfaceAgentDir);
    const settingsManager = SettingsManager.inMemory({
      compaction: { keepRecentTokens: 30_000 },
      defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
    settingsManager.setTransport(config.piTransport);

    const additionalSkillPaths: string[] = [];
    resourceMessages = [];
    if (fs.existsSync(config.flitterbotSkillsDir)) {
      additionalSkillPaths.push(config.flitterbotSkillsDir);
    } else {
      resourceMessages.push(`bundled skills directory missing: ${config.flitterbotSkillsDir}`);
    }
    const builtInSkillPaths = [path.join(HOME, ".claude", "skills")];
    additionalSkillPaths.push(...builtInSkillPaths.filter((entry) => fs.existsSync(entry)));
    for (const entry of config.extraSkillPaths) {
      if (fs.existsSync(entry)) {
        additionalSkillPaths.push(entry);
      } else {
        resourceMessages.push(`extraSkillPaths: missing directory skipped: ${entry}`);
      }
    }

    const useConfiguredDefault =
      factoryOpts.sessionStartEvent?.reason === "new" ||
      (!resumeSessionFile && factoryOpts.sessionStartEvent === undefined);
    const modelEntry = useConfiguredDefault ? resolveModelEntry(config) : undefined;
    const model = modelEntry
      ? modelRuntime.getModel(modelEntry.provider, modelEntry.modelId)
      : undefined;
    if (modelEntry && !model) {
      throw new Error(
        `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId} (entry id=${modelEntry.id}). ` +
          `Not in the built-in catalog or ~/.flitterbot/control-surface/agent/models.json.`,
      );
    }
    const effectiveThinkingLevel = modelEntry
      ? (modelEntry.thinkingLevel ?? config.defaultThinkingLevel)
      : undefined;
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
    const grep = createGrepToolDefinition(factoryOpts.cwd);
    grep.description = grep.description.replace(
      /truncated to \d+ matches/,
      `truncated to ${GREP_DEFAULT_LIMIT} matches`,
    );
    grep.parameters.properties.limit = {
      ...grep.parameters.properties.limit,
      description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})`,
    } as typeof grep.parameters.properties.limit;
    const grepWithHigherDefault: typeof grep = {
      ...grep,
      execute(id, params, signal, onUpdate, context) {
        return grep.execute(
          id,
          { ...params, limit: params.limit ?? GREP_DEFAULT_LIMIT },
          signal,
          onUpdate,
          context,
        );
      },
    };
    const services = await createAgentSessionServices({
      cwd: factoryOpts.cwd,
      agentDir: config.piAgentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        additionalSkillPaths,
        extensionFactories: [
          createFlitterbotExtension([...customTools, grepWithHigherDefault as FlitterbotTool]),
        ],
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
      entryId: resolveModelEntryId(loadConfig(), currentModel.provider, currentModel.id),
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
