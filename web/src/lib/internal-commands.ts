import type { SkillPickerItem } from "~/lib/types";

export type InternalCommandScope = "default-stream" | "work-stream" | "surface";

export const INTERNAL_COMMANDS: SkillPickerItem[] = [
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
    description: "Clone this session into a new swimlane",
    disableModelInvocation: true,
    kind: "command",
  },
];

const NEW_STREAM_COMMAND: SkillPickerItem = {
  name: "new-stream",
  description: "Start a new work swimlane",
  disableModelInvocation: true,
  kind: "command",
};

const CONTEXTUAL_COMMANDS: Record<InternalCommandScope, SkillPickerItem[]> = {
  "default-stream": [NEW_STREAM_COMMAND],
  "work-stream": [],
  surface: [NEW_STREAM_COMMAND],
};

export function getInternalCommandsForScope(scope: InternalCommandScope): SkillPickerItem[] {
  return [...INTERNAL_COMMANDS, ...CONTEXTUAL_COMMANDS[scope]];
}
