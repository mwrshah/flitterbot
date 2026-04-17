import type { SkillListItem } from "~/lib/types";

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
];
