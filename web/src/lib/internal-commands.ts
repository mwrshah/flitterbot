import type { SkillListItem } from "~/lib/types";

export type InternalCommandScope = "default-stream" | "work-stream" | "surface";

export const INTERNAL_COMMANDS: SkillListItem[] = [
  {
    name: "clear",
    description: "Reset the current session",
    disableModelInvocation: true,
    kind: "command",
  },
  {
    name: "reload",
    description: "Reload skills, prompts, and system prompt from disk",
    disableModelInvocation: true,
    kind: "command",
  },
  {
    name: "compact",
    description: "Compact the current Pi session context",
    disableModelInvocation: true,
    kind: "command",
  },
  {
    name: "fork",
    description: "Clone this session into a new stream",
    disableModelInvocation: true,
    kind: "command",
  },
];

const NEW_STREAM_COMMAND: SkillListItem = {
  name: "new-stream",
  description: "Start a new work stream",
  disableModelInvocation: true,
  kind: "command",
};

const CONTEXTUAL_COMMANDS: Record<InternalCommandScope, SkillListItem[]> = {
  "default-stream": [NEW_STREAM_COMMAND],
  "work-stream": [],
  surface: [NEW_STREAM_COMMAND],
};

export function getInternalCommandsForScope(scope: InternalCommandScope): SkillListItem[] {
  return [...INTERNAL_COMMANDS, ...CONTEXTUAL_COMMANDS[scope]];
}
