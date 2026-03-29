import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
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
import type { AutonomaConfig } from "../config/load-config.ts";
import type { OrchestratorContext } from "../prompts/index.ts";
import { buildDefaultAgentPrompt, buildOrchestratorPrompt } from "../prompts/index.ts";

/** Orchestrator context as provided by the caller — piSessionId is injected internally. */
type OrchestratorInput = Omit<OrchestratorContext, "piSessionId">;

const HOME = os.homedir();

type PiRole = "default" | "orchestrator";

/**
 * Custom tools use plain JSON Schema objects for `parameters` (not TypeBox TSchema),
 * so we accept a loose array and cast to ToolDefinition[] at the SDK boundary.
 */
type CreateAutonomaAgentOptions = {
  config: AutonomaConfig;
  customTools: unknown[];
  role?: PiRole;
  orchestratorContext?: OrchestratorInput;
  /** When set, resume an existing session from this JSONL file instead of creating a new one. */
  resumeSessionFile?: string;
};

export async function createAutonomaAgent(options: CreateAutonomaAgentOptions) {
  const { config, customTools, role = "default", orchestratorContext, resumeSessionFile } = options;
  const workingDir = config.projectsDir;

  // Create SessionManager early so we can read the piSessionId before building the prompt.
  // SessionManager generates its sessionId in the constructor (via newSession()),
  // and createAgentSession reuses this same instance — so the IDs match.
  // If resuming an existing session, open its JSONL file to preserve the piSessionId
  // and conversation history. Otherwise create a fresh session.
  const sessionManager = resumeSessionFile
    ? SessionManager.open(resumeSessionFile, config.controlSurfaceSessionsDir)
    : SessionManager.create(workingDir, config.controlSurfaceSessionsDir);
  const piSessionId = sessionManager.getSessionId();

  let systemPrompt = resolveSystemPrompt(role, piSessionId, orchestratorContext);

  // Mutable ref so the systemPromptOverride closure always reads the final prompt
  // (skills are appended after resourceLoader is created). Each agent gets its own
  // ref — no shared file read — which fixes the concurrent-orchestrator race condition.
  const promptRef = { value: "" };

  // Use the canonical Pi auth — same OAuth tokens the Pi CLI uses after `pi auth login`.
  const piAuthPath = path.join(HOME, ".pi", "agent", "auth.json");
  const authPath = fs.existsSync(piAuthPath)
    ? piAuthPath
    : path.join(config.controlSurfaceAgentDir, "auth.json");
  const authStorage = AuthStorage.create(authPath);
  // Use ~/.pi/agent as the agent dir — same as the Pi CLI. This picks up
  // AGENTS.md, models.json, and any agent-level config from the canonical location.
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
    systemPromptOverride: () => promptRef.value,
  });
  await resourceLoader.reload();

  // Append auto-loaded skills to the system prompt using SDK-discovered paths.
  const { skills } = resourceLoader.getSkills();
  systemPrompt += buildAutoLoadedSkillsBlock(skills);
  promptRef.value = systemPrompt;
  console.log("[create-agent] system prompt:\n" + "=".repeat(80) + "\n" + systemPrompt + "\n" + "=".repeat(80));
  // Write prompt file for debugging/logging — no longer the live source for the override.
  ensurePromptFile(config.controlSurfacePromptPath, systemPrompt);

  // Collect resource info for startup logging
  const { agentsFiles } = resourceLoader.getAgentsFiles();
  const skillNames = skills.map((s) => s.name);
  const agentsFilePaths = agentsFiles.map((f) => f.path);

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
    },
    resourceInfo: {
      skillNames,
      agentsFilePaths,
    },
  };
}

/** Skill files to auto-load into the system prompt so the agent doesn't need `/load2-w`. */
const AUTO_LOAD_SKILLS = ["tmux2", "todoist", "my-obsidian"] as const;

function resolveSystemPrompt(role: PiRole, piSessionId: string, ctx?: OrchestratorInput): string {
  if (role === "orchestrator") {
    if (!ctx) throw new Error("orchestratorContext is required for orchestrator role");
    return buildOrchestratorPrompt({ ...ctx, piSessionId });
  }
  return buildDefaultAgentPrompt(piSessionId);
}

function buildAutoLoadedSkillsBlock(discoveredSkills: { name: string; filePath: string }[]): string {
  const skillsByName = new Map(discoveredSkills.map((s) => [s.name, s]));
  const sections: string[] = [];
  for (const name of AUTO_LOAD_SKILLS) {
    const skill = skillsByName.get(name);
    if (!skill) continue;
    try {
      let content = fs.readFileSync(skill.filePath, "utf8");
      // Strip YAML frontmatter (skill-loader metadata, not useful in the prompt).
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      // Remove $ARGUMENTS placeholders (only meaningful at invocation time).
      content = content.replaceAll("$ARGUMENTS", "");
      sections.push(`## ${skill.filePath}\n\n${content.trim()}`);
    } catch {
      // Skill file unreadable — skip gracefully.
    }
  }
  if (sections.length === 0) return "";
  return `\n\n# Auto-loaded Skills\n\n${sections.join("\n\n")}`;
}

function ensurePromptFile(promptPath: string, content: string): void {
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, content, "utf8");
}
