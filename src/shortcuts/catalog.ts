import type { ShortcutDefinition } from "./registry.ts";

export type ShortcutOwner =
  | "app"
  | "sidebar"
  | "model-selector"
  | "conversation"
  | "composer"
  | "stream"
  | "tmux";
type ProductShortcutDefinition = Omit<ShortcutDefinition, "owners"> & {
  owners: readonly ShortcutOwner[];
};

const actions = {
  "nav.surface": { bindings: [{ keys: "Alt+KeyR" }], owners: ["app"] },
  "nav.last-stream": { bindings: [{ keys: "Alt+KeyT" }], owners: ["app"] },
  "nav.stream.next": {
    bindings: [{ keys: "Alt+ArrowDown" }],
    owners: ["sidebar"],
    repeat: true,
  },
  "nav.stream.previous": {
    bindings: [{ keys: "Alt+ArrowUp" }],
    owners: ["sidebar"],
    repeat: true,
  },
  "swimlane.create": { bindings: [{ keys: "Alt+KeyN" }], owners: ["app"] },
  "swimlane.search": {
    bindings: [{ keys: "Alt+KeyF" }, { keys: "Slash", input: "ignore" }],
    owners: ["sidebar"],
  },
  "model.search": { bindings: [{ keys: "Alt+KeyM" }], owners: ["model-selector"] },
  "conversation.find": {
    bindings: [{ keys: "Meta+KeyF" }, { keys: "Ctrl+KeyF" }, { keys: "f", input: "ignore" }],
    owners: ["conversation"],
  },
  "scroll.half-page-down": {
    bindings: [{ keys: "Ctrl+KeyD" }, { keys: "d", input: "ignore" }],
    owners: ["app"],
    repeat: true,
  },
  "scroll.half-page-up": {
    bindings: [{ keys: "Ctrl+KeyU" }, { keys: "u", input: "ignore" }],
    owners: ["app"],
    repeat: true,
  },
  "scroll.full-page-down": { bindings: [], owners: ["app"], repeat: true },
  "scroll.full-page-up": { bindings: [], owners: ["app"], repeat: true },
  "scroll.small-down": {
    bindings: [{ keys: "j", input: "ignore" }],
    owners: ["app"],
    repeat: true,
  },
  "scroll.small-up": { bindings: [{ keys: "k", input: "ignore" }], owners: ["app"], repeat: true },
  "scroll.top": { bindings: [{ keys: "g g", input: "ignore" }], owners: ["app"] },
  "scroll.bottom": {
    bindings: [{ keys: "Shift+KeyG", input: "ignore" }],
    owners: ["conversation", "app"],
  },
  "composer.focus": { bindings: [{ keys: "i", input: "ignore" }], owners: ["composer"] },
  "stream.copy-worktree-path": {
    bindings: [{ keys: "c w", input: "ignore" }],
    owners: ["stream", "app"],
  },
  "stream.copy-repo-path": {
    bindings: [{ keys: "c r", input: "ignore" }],
    owners: ["stream", "app"],
  },
  "stream.edit-current-directory": {
    bindings: [{ keys: "c d", input: "ignore" }],
    owners: ["conversation", "app"],
  },
  "stream.copy-branch": { bindings: [{ keys: "c b", input: "ignore" }], owners: ["stream", "app"] },
  "stream.copy-target-branch": {
    bindings: [{ keys: "c t", input: "ignore" }],
    owners: ["stream", "app"],
  },
  "panel.view.info": { bindings: [{ keys: "Alt+KeyI" }], owners: ["stream"] },
  "panel.view.diff": { bindings: [{ keys: "Alt+KeyK" }], owners: ["stream"] },
} as const satisfies Record<string, ProductShortcutDefinition>;

export const STREAM_SHORTCUT_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS = [
  "a",
  "s",
  "g",
  "w",
  "y",
  "e",
  "z",
  "x",
  "v",
  "b",
] as const;
export const TMUX_SESSION_NAMES = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "aa",
  "ab",
  "ac",
  "ad",
  "ae",
  "af",
  "ag",
  "ah",
  "ai",
  "aj",
  "ak",
  "al",
  "am",
  "an",
  "ao",
  "ap",
  "aq",
  "ar",
  "as",
  "at",
  "au",
  "av",
  "aw",
  "ax",
] as const;

type StreamSlot = (typeof STREAM_SHORTCUT_SLOTS)[number];
type ComposerSlot = StreamSlot | 10;
type TmuxSessionName = (typeof TMUX_SESSION_NAMES)[number];
export type ShortcutActionId =
  | keyof typeof actions
  | `nav.stream.slot.${StreamSlot}`
  | `message-input.button.slot.${ComposerSlot}`
  | `stream.copy-tmux-attach.${TmuxSessionName}`;
type CatalogEntry = readonly [ShortcutActionId, ProductShortcutDefinition];

export function getStreamSlotShortcutActionId(slot: number): `nav.stream.slot.${StreamSlot}` {
  if (!Number.isInteger(slot) || slot < 1 || slot > STREAM_SHORTCUT_SLOTS.length) {
    throw new Error(`Invalid stream shortcut slot: ${slot}`);
  }
  return `nav.stream.slot.${slot as StreamSlot}`;
}

export function getMessageInputButtonShortcutActionId(
  slot: number,
): `message-input.button.slot.${ComposerSlot}` {
  if (!Number.isInteger(slot) || slot < 1 || slot > MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS.length) {
    throw new Error(`Invalid composer shortcut slot: ${slot}`);
  }
  return `message-input.button.slot.${slot as ComposerSlot}`;
}

export function getTmuxAttachShortcutActionId(
  session: string,
): `stream.copy-tmux-attach.${TmuxSessionName}` | undefined {
  return (TMUX_SESSION_NAMES as readonly string[]).includes(session)
    ? `stream.copy-tmux-attach.${session as TmuxSessionName}`
    : undefined;
}

export const SHORTCUT_CATALOG = Object.fromEntries([
  ...Object.entries(actions),
  ...STREAM_SHORTCUT_SLOTS.map(
    (slot): CatalogEntry => [
      getStreamSlotShortcutActionId(slot),
      { bindings: [{ keys: `Alt+Digit${slot}` }], owners: ["app"] },
    ],
  ),
  ...MESSAGE_INPUT_BUTTON_SHORTCUT_KEYS.map(
    (key, index): CatalogEntry => [
      getMessageInputButtonShortcutActionId(index + 1),
      { bindings: [{ keys: `Alt+Key${key.toUpperCase()}` }], owners: ["composer"] },
    ],
  ),
  ...TMUX_SESSION_NAMES.map(
    (session): CatalogEntry => [
      `stream.copy-tmux-attach.${session}`,
      {
        bindings: [{ keys: `t ${session.split("").join(" ")}`, input: "ignore" }],
        owners: ["tmux"],
      },
    ],
  ),
]) as Record<ShortcutActionId, ShortcutDefinition>;

export const SHORTCUT_OPTIONS = { allowPrefixes: true, sequenceTimeoutMs: 750 } as const;
