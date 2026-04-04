import { useSyncExternalStore } from "react";
import type { ShortcutBindingsConfig } from "./types";

let focusComposer: (() => void) | null = null;

export type ShortcutAvailability = "always" | "no-input-focus";
export type ShortcutHandlerResult = boolean | undefined;
export type ShortcutHandler = (event: KeyboardEvent) => ShortcutHandlerResult;

type ShortcutModifier = "alt" | "ctrl" | "meta" | "shift";

type ShortcutStep = {
  code?: string;
  key?: string;
  modifiers: ShortcutModifier[];
};

type ShortcutBindingSpec = {
  spec: string;
  when: ShortcutAvailability;
};

type ShortcutDefinition = {
  defaultBindings: readonly ShortcutBindingSpec[];
};

type ParsedShortcutBinding = {
  id: string;
  spec: string;
  steps: readonly ShortcutStep[];
  timeoutMs: number;
  when: ShortcutAvailability;
};

type ShortcutHandlerEntry = {
  token: number;
  order: number;
  priority: number;
  handler: ShortcutHandler;
};

type SequenceProgress = {
  actionId: string;
  binding: ParsedShortcutBinding;
  nextStepIndex: number;
  deadline: number;
};

type BindingMatch = {
  actionId: string;
  binding: ParsedShortcutBinding;
  priority: number;
};

const DEFAULT_SEQUENCE_TIMEOUT_MS = 500;
const STREAM_SLOT_DIGIT_CODES = [
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
] as const;
const STREAM_SLOT_HOME_ROW_CODES = [
  "KeyM",
  "Comma",
  "Period",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyU",
  "KeyI",
  "KeyO",
] as const;
const KEY_TOKEN_ALIASES: Record<string, string> = {
  space: " ",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  comma: ",",
  period: ".",
  slash: "/",
};
const CODE_TOKEN_ALIASES: Record<string, string> = {
  comma: "Comma",
  period: "Period",
  slash: "Slash",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
};
const definitions = new Map<string, ShortcutDefinition>();
const handlerEntries = new Map<string, ShortcutHandlerEntry[]>();
const parsedBindingsCache = new Map<string, ParsedShortcutBinding[]>();
const bindingListeners = new Set<() => void>();

let nextHandlerToken = 1;
let nextHandlerOrder = 1;
let sequenceProgress: SequenceProgress[] = [];
let bindingOverrides: ShortcutBindingsConfig = {};

export const SHORTCUT_ACTIONS = {
  navSurface: "nav.surface",
  navLastStream: "nav.last-stream",
  scrollHalfPageDown: "scroll.half-page-down",
  scrollHalfPageUp: "scroll.half-page-up",
  scrollFullPageDown: "scroll.full-page-down",
  scrollFullPageUp: "scroll.full-page-up",
  scrollTop: "scroll.top",
  scrollBottom: "scroll.bottom",
  composerFocus: "composer.focus",
  streamCopyTmuxAttach: "stream.copy-tmux-attach",
  streamCopyWorktreePath: "stream.copy-worktree-path",
  panelViewInfo: "panel.view.info",
  panelViewDiff: "panel.view.diff",
} as const;

/** Returns true when the active element is an input, textarea, contenteditable, or role=textbox. */
export function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.getAttribute("role") === "textbox") return true;
  return false;
}

// The app currently exposes one primary composer at a time, so a single
// registered focus target keeps global shortcut ownership centralized.
export function registerComposerFocusTarget(handler: (() => void) | null) {
  focusComposer = handler;
}

export function focusComposerInput() {
  focusComposer?.();
}

let activeScrollTarget: "main" | "diff" = "main";

export function setActiveScrollContainer(target: "main" | "diff") {
  activeScrollTarget = target;
}

export function getActiveScrollContainerSelector(): string {
  return `[data-scroll-container="${activeScrollTarget}"]`;
}

export function defineShortcutAction(actionId: string, definition: ShortcutDefinition) {
  definitions.set(actionId, {
    defaultBindings: [...definition.defaultBindings],
  });
  parsedBindingsCache.delete(actionId);
}

export function getStreamSlotShortcutActionId(slot: number) {
  return `nav.stream.slot.${slot}`;
}

export function setShortcutBindingOverrides(next: ShortcutBindingsConfig | null | undefined) {
  bindingOverrides = next ?? {};
  parsedBindingsCache.clear();
  sequenceProgress = [];
  for (const listener of bindingListeners) listener();
}

export function registerShortcutHandler(
  actionId: string,
  handler: ShortcutHandler,
  options: { priority?: number } = {},
) {
  const token = nextHandlerToken++;
  const nextEntry: ShortcutHandlerEntry = {
    token,
    order: nextHandlerOrder++,
    priority: options.priority ?? 0,
    handler,
  };
  const existing = handlerEntries.get(actionId) ?? [];
  handlerEntries.set(actionId, [...existing, nextEntry]);
  return () => {
    const current = handlerEntries.get(actionId);
    if (!current) return;
    const remaining = current.filter((entry) => entry.token !== token);
    if (remaining.length === 0) {
      handlerEntries.delete(actionId);
      return;
    }
    handlerEntries.set(actionId, remaining);
  };
}

export function registerShortcutHandlers(
  entries: Array<{ actionId: string; handler: ShortcutHandler; priority?: number }>,
) {
  const cleanups = entries.map(({ actionId, handler, priority }) =>
    registerShortcutHandler(actionId, handler, { priority }),
  );
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

export function handleRegisteredShortcutKeyDown(event: KeyboardEvent) {
  const now = Date.now();
  const inputFocused = isInputFocused();
  sequenceProgress = sequenceProgress.filter(
    (progress) =>
      progress.deadline >= now &&
      hasHandlers(progress.actionId) &&
      isBindingAvailable(progress.binding, inputFocused),
  );

  if (sequenceProgress.length > 0) {
    const continued = event.repeat
      ? []
      : sequenceProgress.filter((progress) =>
          matchesShortcutStep(progress.binding.steps[progress.nextStepIndex], event),
        );
    if (continued.length > 0) {
      const completed = continued.filter(
        (progress) => progress.nextStepIndex + 1 >= progress.binding.steps.length,
      );
      if (completed.length > 0) {
        const chosen = pickBestBindingMatch(
          completed.map((progress) => ({
            actionId: progress.actionId,
            binding: progress.binding,
            priority: getHighestHandlerPriority(progress.actionId),
          })),
        );
        sequenceProgress = [];
        if (!chosen) return false;
        if (dispatchShortcutAction(chosen.actionId, event)) {
          event.preventDefault();
          return true;
        }
        return false;
      }

      sequenceProgress = continued.map((progress) => ({
        ...progress,
        nextStepIndex: progress.nextStepIndex + 1,
        deadline: now + progress.binding.timeoutMs,
      }));
      return false;
    }

    sequenceProgress = [];
  }

  const activeBindings = getActiveBindings(inputFocused);
  const comboMatches = activeBindings.filter(
    ({ binding }) => binding.steps.length === 1 && matchesShortcutStep(binding.steps[0], event),
  );
  if (comboMatches.length > 0) {
    const chosen = pickBestBindingMatch(comboMatches);
    if (chosen && dispatchShortcutAction(chosen.actionId, event)) {
      event.preventDefault();
      return true;
    }
  }

  const sequenceStarts = activeBindings.filter(
    ({ binding }) =>
      !event.repeat && binding.steps.length > 1 && matchesShortcutStep(binding.steps[0], event),
  );
  if (sequenceStarts.length > 0) {
    sequenceProgress = sequenceStarts.map(({ actionId, binding }) => ({
      actionId,
      binding,
      nextStepIndex: 1,
      deadline: now + binding.timeoutMs,
    }));
  }

  return false;
}

export function getShortcutBindingLabel(
  actionId: string,
  options: { compact?: boolean; altLabel?: string } = {},
) {
  const [binding] = getParsedBindings(actionId);
  if (!binding) return "";
  return formatShortcutBinding(binding, options);
}

export function useShortcutBindingLabel(
  actionId: string,
  options: { compact?: boolean; altLabel?: string } = {},
) {
  return useSyncExternalStore(
    subscribeToShortcutBindings,
    () => getShortcutBindingLabel(actionId, options),
    () => getShortcutBindingLabel(actionId, options),
  );
}

function hasHandlers(actionId: string) {
  return (handlerEntries.get(actionId)?.length ?? 0) > 0;
}

function subscribeToShortcutBindings(listener: () => void) {
  bindingListeners.add(listener);
  return () => {
    bindingListeners.delete(listener);
  };
}

function isBindingAvailable(binding: ParsedShortcutBinding, inputFocused: boolean) {
  return binding.when === "always" || !inputFocused;
}

function getHighestHandlerPriority(actionId: string) {
  return Math.max(
    ...(handlerEntries.get(actionId)?.map((entry) => entry.priority) ?? [Number.NEGATIVE_INFINITY]),
  );
}

function getActiveBindings(inputFocused: boolean): BindingMatch[] {
  const matches: BindingMatch[] = [];
  for (const [actionId, entries] of handlerEntries) {
    if (entries.length === 0) continue;
    const priority = getHighestHandlerPriority(actionId);
    for (const binding of getParsedBindings(actionId)) {
      if (!isBindingAvailable(binding, inputFocused)) continue;
      matches.push({ actionId, binding, priority });
    }
  }
  return matches;
}

function dispatchShortcutAction(actionId: string, event: KeyboardEvent) {
  const entries = [...(handlerEntries.get(actionId) ?? [])].sort(
    (a, b) => b.priority - a.priority || b.order - a.order,
  );

  for (const entry of entries) {
    try {
      const result = entry.handler(event);
      if (result === false) continue;
      return true;
    } catch (error) {
      console.error(`[shortcuts] action "${actionId}" failed`, error);
      return true;
    }
  }

  return false;
}

function pickBestBindingMatch(matches: BindingMatch[]) {
  return [...matches].sort(
    (a, b) =>
      b.priority - a.priority ||
      b.binding.steps.length - a.binding.steps.length ||
      b.binding.spec.length - a.binding.spec.length,
  )[0];
}

function inferBindingAvailability(spec: string): ShortcutAvailability {
  const stepTokens = spec.trim().split(/\s+/).filter(Boolean);
  for (const token of stepTokens) {
    const parts = token.split("+");
    for (const part of parts.slice(0, -1)) {
      const mod = normalizeModifierToken(part.trim());
      if (mod === "alt" || mod === "ctrl" || mod === "meta") return "always";
    }
  }
  return "no-input-focus";
}

function getParsedBindings(actionId: string): ParsedShortcutBinding[] {
  const cached = parsedBindingsCache.get(actionId);
  if (cached) return cached;

  const definition = definitions.get(actionId);
  const candidateSpecs = normalizeBindingSpecs(bindingOverrides[actionId]);

  let parsedBindings: ParsedShortcutBinding[];
  if (candidateSpecs) {
    const overrideBindingSpecs = candidateSpecs.map((spec) => ({
      spec,
      when: inferBindingAvailability(spec),
    }));
    parsedBindings = parseShortcutBindings(actionId, overrideBindingSpecs);
    if (parsedBindings.length === 0) {
      parsedBindings = parseShortcutBindings(actionId, definition?.defaultBindings ?? []);
    }
  } else {
    parsedBindings = parseShortcutBindings(actionId, definition?.defaultBindings ?? []);
  }

  parsedBindingsCache.set(actionId, parsedBindings);
  return parsedBindings;
}

function normalizeBindingSpecs(value: string | string[] | undefined) {
  if (!value) return null;
  const specs = (Array.isArray(value) ? value : [value]).map((spec) => spec.trim()).filter(Boolean);
  return specs.length > 0 ? specs : null;
}

function parseShortcutBindings(
  actionId: string,
  specs: readonly ShortcutBindingSpec[],
): ParsedShortcutBinding[] {
  return specs
    .map((bindingSpec, index) => parseShortcutBinding(actionId, bindingSpec, index))
    .filter((binding): binding is ParsedShortcutBinding => binding !== null);
}

function parseShortcutBinding(
  actionId: string,
  bindingSpec: ShortcutBindingSpec,
  index: number,
): ParsedShortcutBinding | null {
  const normalizedSpec = bindingSpec.spec.trim();
  if (!normalizedSpec) return null;
  const stepTokens = normalizedSpec.split(/\s+/).filter(Boolean);
  if (stepTokens.length === 0) return null;
  const steps = stepTokens
    .map(parseShortcutStepToken)
    .filter((step): step is ShortcutStep => step !== null);
  if (steps.length !== stepTokens.length) return null;
  return {
    id: `${actionId}:${index}:${normalizedSpec}`,
    spec: normalizedSpec,
    steps,
    timeoutMs: DEFAULT_SEQUENCE_TIMEOUT_MS,
    when: bindingSpec.when,
  };
}

function parseShortcutStepToken(token: string): ShortcutStep | null {
  const parts = token
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers = parts
    .slice(0, -1)
    .map(normalizeModifierToken)
    .filter((modifier): modifier is ShortcutModifier => modifier !== null);
  if (modifiers.length !== parts.length - 1) return null;

  const keyToken = parts[parts.length - 1];
  if (!keyToken) return null;
  const normalizedCode = normalizeCodeToken(keyToken);
  if (normalizedCode) return { code: normalizedCode, modifiers };

  const normalizedKey = normalizeKeyToken(keyToken);
  if (!normalizedKey) return null;
  return { key: normalizedKey, modifiers };
}

function normalizeModifierToken(token: string): ShortcutModifier | null {
  switch (token.toLowerCase()) {
    case "alt":
    case "opt":
    case "option":
      return "alt";
    case "ctrl":
    case "control":
      return "ctrl";
    case "cmd":
    case "command":
    case "meta":
      return "meta";
    case "shift":
      return "shift";
    default:
      return null;
  }
}

const KNOWN_CODES = new Set([
  "Comma",
  "Period",
  "Slash",
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
]);

function normalizeCodeToken(token: string) {
  const candidate = CODE_TOKEN_ALIASES[token.toLowerCase()] ?? token;
  if (/^Key[A-Z]$/.test(candidate)) return candidate;
  if (/^Digit[0-9]$/.test(candidate)) return candidate;
  if (KNOWN_CODES.has(candidate)) return candidate;
  if (/^Arrow(Up|Down|Left|Right)$/.test(candidate)) return candidate;
  return null;
}

function normalizeKeyToken(token: string) {
  if (token.length === 1) return token.toLowerCase();
  return KEY_TOKEN_ALIASES[token.toLowerCase()] ?? null;
}

function matchesShortcutStep(step: ShortcutStep | undefined, event: KeyboardEvent) {
  if (!step) return false;
  if (!modifiersMatch(step.modifiers, event)) return false;
  if (step.code) return event.code === step.code;
  if (!step.key) return false;
  return normalizeEventKey(event.key) === step.key;
}

function modifiersMatch(modifiers: readonly ShortcutModifier[], event: KeyboardEvent) {
  return (
    event.altKey === modifiers.includes("alt") &&
    event.ctrlKey === modifiers.includes("ctrl") &&
    event.metaKey === modifiers.includes("meta") &&
    event.shiftKey === modifiers.includes("shift")
  );
}

function normalizeEventKey(key: string) {
  return key.length === 1 ? key.toLowerCase() : key;
}

function formatShortcutBinding(
  binding: ParsedShortcutBinding,
  options: { compact?: boolean; altLabel?: string },
) {
  if (
    options.compact &&
    binding.steps.every((step) => step.modifiers.length === 0 && isCompactStep(step))
  ) {
    if (binding.steps.length > 1) {
      return binding.steps
        .map((step) => formatStepKey(step))
        .join(" then ")
        .toLowerCase();
    }
    return binding.steps
      .map((step) => formatStepKey(step))
      .join("")
      .toUpperCase();
  }
  return binding.steps.map((step) => formatShortcutStep(step, options)).join(" ");
}

function isCompactStep(step: ShortcutStep) {
  const key = formatStepKey(step);
  return key.length === 1;
}

function formatShortcutStep(step: ShortcutStep, options: { compact?: boolean; altLabel?: string }) {
  const modifiers = step.modifiers.map((modifier) => formatModifier(modifier, options.altLabel));
  const key = formatStepKey(step);
  return modifiers.length > 0 ? `${modifiers.join("+")}+${key}` : key.toUpperCase();
}

function formatModifier(modifier: ShortcutModifier, altLabel?: string) {
  switch (modifier) {
    case "alt":
      return altLabel || "Alt";
    case "ctrl":
      return "Ctrl";
    case "meta":
      return "Cmd";
    case "shift":
      return "Shift";
  }
}

function formatStepKey(step: ShortcutStep) {
  if (step.code) return formatCodeLabel(step.code);
  if (!step.key) return "";
  if (step.key === " ") return "Space";
  return step.key;
}

function formatCodeLabel(code: string) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  switch (code) {
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "Backquote":
      return "`";
    case "Backslash":
      return "\\";
    default:
      return code;
  }
}

function registerBuiltInShortcutDefinitions() {
  defineShortcutAction(SHORTCUT_ACTIONS.navSurface, {
    defaultBindings: [
      { spec: "Alt+KeyR", when: "always" },
      { spec: "r", when: "no-input-focus" },
    ],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.navLastStream, {
    defaultBindings: [
      { spec: "Alt+KeyT", when: "always" },
      { spec: "t", when: "no-input-focus" },
    ],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.scrollHalfPageDown, {
    defaultBindings: [
      { spec: "Ctrl+KeyD", when: "always" },
      { spec: "d", when: "no-input-focus" },
    ],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.scrollHalfPageUp, {
    defaultBindings: [
      { spec: "Ctrl+KeyU", when: "always" },
      { spec: "u", when: "no-input-focus" },
    ],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.scrollFullPageDown, {
    defaultBindings: [
      { spec: "Ctrl+KeyF", when: "always" },
      { spec: "f", when: "no-input-focus" },
    ],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.scrollFullPageUp, {
    defaultBindings: [
      { spec: "Ctrl+KeyB", when: "always" },
      { spec: "b", when: "no-input-focus" },
    ],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.scrollTop, {
    defaultBindings: [{ spec: "g g", when: "no-input-focus" }],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.scrollBottom, {
    defaultBindings: [{ spec: "Shift+KeyG", when: "no-input-focus" }],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.composerFocus, {
    defaultBindings: [{ spec: "i", when: "no-input-focus" }],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.streamCopyTmuxAttach, {
    defaultBindings: [{ spec: "c t", when: "no-input-focus" }],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.streamCopyWorktreePath, {
    defaultBindings: [{ spec: "c w", when: "no-input-focus" }],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.panelViewInfo, {
    defaultBindings: [{ spec: "Ctrl+KeyI", when: "always" }],
  });
  defineShortcutAction(SHORTCUT_ACTIONS.panelViewDiff, {
    defaultBindings: [{ spec: "Ctrl+KeyK", when: "always" }],
  });

  for (let slot = 0; slot < STREAM_SLOT_DIGIT_CODES.length; slot++) {
    defineShortcutAction(getStreamSlotShortcutActionId(slot + 1), {
      defaultBindings: [
        { spec: `Alt+${STREAM_SLOT_DIGIT_CODES[slot]}`, when: "always" },
        { spec: `Alt+${STREAM_SLOT_HOME_ROW_CODES[slot]}`, when: "always" },
      ],
    });
  }
}

registerBuiltInShortcutDefinitions();
