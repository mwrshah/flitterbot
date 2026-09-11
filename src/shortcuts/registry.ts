/**
 * DOM-independent shortcut registry. Native keyboard events satisfy its structural event type.
 * Code and character bindings diverge across layouts, so matching keeps both paths alive.
 * Prefix mode closes the entire buffer on inactivity; an invalid tail suppresses all matches.
 * Ownership changes cancel pending input; callback errors never promote a fallback owner.
 * See docs/shortcuts/FEATURE.md for the public contracts and lifecycle rules.
 */

export type ShortcutBinding = {
  keys: string;
  input?: "allow" | "ignore";
};

export type ShortcutDefinition = {
  bindings: readonly ShortcutBinding[];
  owners: readonly string[];
  repeat?: boolean;
};

export type ShortcutCatalog = Record<string, ShortcutDefinition>;

export type ShortcutKeyboardEvent = {
  readonly key: string;
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
};

export type ShortcutHandler = {
  enabled?: boolean | ((event: ShortcutKeyboardEvent) => boolean);
  run: (event: ShortcutKeyboardEvent) => void;
};

export type ShortcutHandlers = Record<string, ShortcutHandler>;

export type ShortcutLabelOptions = { compact?: boolean; altLabel?: string };

export type ShortcutRegistry = {
  register: (owner: string, handlers: ShortcutHandlers) => () => void;
  setOverrides: (overrides: unknown) => void;
  handleKeyDown: (event: ShortcutKeyboardEvent, inputFocused?: boolean) => boolean;
  getLabel: (actionId: string, options?: ShortcutLabelOptions) => string;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
  dispose: () => void;
};

export class ShortcutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShortcutConfigError";
  }
}

type Modifier = "alt" | "ctrl" | "meta" | "shift";

type StepKind = "code" | "key";

export type ShortcutStep = {
  readonly kind: StepKind;
  readonly value: string;
  readonly modifiers: readonly Modifier[];
  readonly token: string;
  readonly aliasToken: string;
};

export type CompiledBinding = {
  readonly actionId: string;
  readonly input: "allow" | "ignore";
  readonly spec: string;
  readonly steps: readonly ShortcutStep[];
};

export type ShortcutTrieNode = {
  readonly next: Map<string, ShortcutTrieNode>;
  readonly depth: number;
  readonly reachable: CompiledBinding[];
  binding: CompiledBinding | null;
};

export type CompiledBindings = {
  readonly allowPrefixes: boolean;
  readonly signature: string;
  readonly bindings: ReadonlyMap<string, readonly CompiledBinding[]>;
  readonly root: ShortcutTrieNode;
};

const DEFAULT_SEQUENCE_TIMEOUT_MS = 750;

const MODIFIER_ALIASES = new Map<string, Modifier>([
  ["alt", "alt"],
  ["opt", "alt"],
  ["option", "alt"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["cmd", "meta"],
  ["command", "meta"],
  ["meta", "meta"],
  ["shift", "shift"],
]);

const CODE_TOKENS = new Set([
  "Comma",
  "Period",
  "Slash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Minus",
  "Equal",
  "Backquote",
  "Backslash",
  "Space",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

const NAMED_KEYS = new Map<string, string>([
  ["enter", "Enter"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["tab", "Tab"],
  ["space", " "],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["del", "Delete"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["up", "ArrowUp"],
  ["down", "ArrowDown"],
  ["left", "ArrowLeft"],
  ["right", "ArrowRight"],
  ["arrowup", "ArrowUp"],
  ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["comma", ","],
  ["period", "."],
  ["dot", "."],
  ["slash", "/"],
]);

const CODE_KEY_LABELS = new Map<string, string>([
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Minus", "-"],
  ["Equal", "="],
  ["Backquote", "`"],
  ["Backslash", "\\"],
  ["Space", " "],
]);

const MODIFIER_ONLY_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);

const KEY_CODE_PATTERN = /^Key[A-Z]$/;
const DIGIT_CODE_PATTERN = /^Digit[0-9]$/;
const FUNCTION_KEY_PATTERN = /^F([1-9]|1[0-2])$/;

function getDefinition(catalog: ShortcutCatalog, actionId: string): ShortcutDefinition | null {
  if (!Object.hasOwn(catalog, actionId)) return null;
  return catalog[actionId] ?? null;
}

function bindingError(actionId: string, spec: string, reason: string) {
  return new ShortcutConfigError(`shortcut "${actionId}" binding "${spec}": ${reason}`);
}

function modifierMask(modifiers: readonly Modifier[]) {
  return (
    (modifiers.includes("alt") ? 1 : 0) |
    (modifiers.includes("ctrl") ? 2 : 0) |
    (modifiers.includes("meta") ? 4 : 0) |
    (modifiers.includes("shift") ? 8 : 0)
  );
}

function aliasId(kind: StepKind, value: string) {
  if (kind === "key") return value;
  if (KEY_CODE_PATTERN.test(value)) return value.slice(3).toLowerCase();
  if (DIGIT_CODE_PATTERN.test(value)) return value.slice(5);
  return CODE_KEY_LABELS.get(value) ?? value;
}

function makeStep(kind: StepKind, value: string, modifiers: readonly Modifier[]): ShortcutStep {
  const mask = modifierMask(modifiers);
  return {
    kind,
    value,
    modifiers,
    token: `${mask}#${kind}#${value}`,
    aliasToken: `${mask}#${aliasId(kind, value)}`,
  };
}

function parseStep(actionId: string, spec: string, token: string): ShortcutStep {
  const parts = token.split("+");
  const modifiers: Modifier[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (!modifier) throw bindingError(actionId, spec, `unknown modifier "${part}"`);
    if (modifiers.includes(modifier)) {
      throw bindingError(actionId, spec, `repeated modifier "${modifier}"`);
    }
    modifiers.push(modifier);
  }

  modifiers.sort();
  const keyToken = parts[parts.length - 1] ?? "";
  if (!keyToken) throw bindingError(actionId, spec, `step "${token}" has an empty key`);

  if (
    CODE_TOKENS.has(keyToken) ||
    KEY_CODE_PATTERN.test(keyToken) ||
    DIGIT_CODE_PATTERN.test(keyToken)
  ) {
    return makeStep("code", keyToken, modifiers);
  }

  const named = NAMED_KEYS.get(keyToken.toLowerCase());
  if (named) return makeStep("key", named, modifiers);
  if (FUNCTION_KEY_PATTERN.test(keyToken.toUpperCase())) {
    return makeStep("key", keyToken.toUpperCase(), modifiers);
  }
  if (keyToken.length === 1) return makeStep("key", keyToken.toLowerCase(), modifiers);

  throw bindingError(actionId, spec, `unknown key "${keyToken}"`);
}

function parseGesture(actionId: string, raw: unknown): CompiledBinding {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShortcutConfigError(
      `shortcut "${actionId}" bindings must be objects with keys and optional input`,
    );
  }
  const { keys, input = "allow" } = raw as ShortcutBinding;
  if (
    typeof keys !== "string" ||
    (input !== "allow" && input !== "ignore") ||
    Object.keys(raw).some((key) => key !== "keys" && key !== "input")
  ) {
    throw new ShortcutConfigError(
      `shortcut "${actionId}" binding needs string keys and input "allow" or "ignore"`,
    );
  }
  const tokens = keys.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new ShortcutConfigError(`shortcut "${actionId}" has a blank binding`);
  }
  const spec = tokens.join(" ");
  return { actionId, input, spec, steps: tokens.map((token) => parseStep(actionId, spec, token)) };
}

function createNode(depth: number): ShortcutTrieNode {
  return { next: new Map(), depth, reachable: [], binding: null };
}

function insertMatchPath(root: ShortcutTrieNode, binding: CompiledBinding) {
  let node = root;
  for (const step of binding.steps) {
    let next = node.next.get(step.token);
    if (!next) {
      next = createNode(node.depth + 1);
      node.next.set(step.token, next);
    }
    node = next;
    node.reachable.push(binding);
  }
  node.binding = binding;
}

function insertAliasPath(
  root: ShortcutTrieNode,
  binding: CompiledBinding,
  actionId: string,
  allowPrefixes: boolean,
) {
  let node = root;
  for (const step of binding.steps) {
    if (node.binding && !allowPrefixes) {
      throw new ShortcutConfigError(
        `shortcut "${actionId}" binding "${binding.spec}" extends "${node.binding.actionId}", which already ends there`,
      );
    }
    let next = node.next.get(step.aliasToken);
    if (!next) {
      next = createNode(node.depth + 1);
      node.next.set(step.aliasToken, next);
    }
    node = next;
  }
  if (node.binding && node.binding.actionId !== actionId) {
    throw new ShortcutConfigError(
      `shortcut "${actionId}" binding "${binding.spec}" duplicates "${node.binding.actionId}"`,
    );
  }
  if (node.next.size > 0 && !allowPrefixes) {
    throw new ShortcutConfigError(
      `shortcut "${actionId}" binding "${binding.spec}" is a prefix of another binding`,
    );
  }
  node.binding = binding;
}

function validateDefinition(actionId: string, definition: ShortcutDefinition) {
  if (!Array.isArray(definition.bindings)) {
    throw new ShortcutConfigError(`shortcut "${actionId}" must declare a bindings array`);
  }
  if (!Array.isArray(definition.owners) || definition.owners.length === 0) {
    throw new ShortcutConfigError(`shortcut "${actionId}" must declare at least one owner`);
  }
  for (const owner of definition.owners) {
    if (typeof owner !== "string" || owner.length === 0) {
      throw new ShortcutConfigError(`shortcut "${actionId}" has a non-string owner`);
    }
  }
  if (new Set(definition.owners).size !== definition.owners.length) {
    throw new ShortcutConfigError(`shortcut "${actionId}" lists a duplicate owner`);
  }
  if (Object.hasOwn(definition, "input")) {
    throw new ShortcutConfigError(
      `shortcut "${actionId}" input belongs on each binding, not the action`,
    );
  }
  if (definition.repeat !== undefined && typeof definition.repeat !== "boolean") {
    throw new ShortcutConfigError(`shortcut "${actionId}" repeat must be a boolean`);
  }
}

function readOverrides(overrides: unknown, catalog: ShortcutCatalog) {
  const specs = new Map<string, readonly unknown[]>();
  if (overrides === undefined) return specs;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ShortcutConfigError("shortcut overrides must be an object");
  }
  for (const [actionId, value] of Object.entries(overrides)) {
    if (!getDefinition(catalog, actionId)) {
      throw new ShortcutConfigError(`shortcut overrides name unknown action "${actionId}"`);
    }
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new ShortcutConfigError(
        `shortcut "${actionId}" override must be an array of binding objects`,
      );
    }
    specs.set(actionId, value);
  }
  return specs;
}

export function compileShortcutBindings(
  catalog: ShortcutCatalog,
  overrides: unknown = {},
  options: { allowPrefixes?: boolean } = {},
): CompiledBindings {
  if (options.allowPrefixes !== undefined && typeof options.allowPrefixes !== "boolean") {
    throw new ShortcutConfigError("allowPrefixes must be a boolean");
  }
  const allowPrefixes = options.allowPrefixes === true;
  const overrideSpecs = readOverrides(overrides, catalog);
  const root = createNode(0);
  const aliasRoot = createNode(0);
  const bindings = new Map<string, readonly CompiledBinding[]>();
  const signatureParts: Array<[string, Array<[string, string[]]>]> = [];

  for (const actionId of Object.keys(catalog).sort()) {
    const definition = getDefinition(catalog, actionId);
    if (!definition || typeof definition !== "object") {
      throw new ShortcutConfigError(`shortcut "${actionId}" has no definition`);
    }
    validateDefinition(actionId, definition);
    const specs = overrideSpecs.get(actionId) ?? definition.bindings;
    const compiled: CompiledBinding[] = [];
    const seen = new Map<string, CompiledBinding>();

    for (const spec of specs) {
      const binding = parseGesture(actionId, spec);
      if (
        binding.input !== "ignore" &&
        binding.steps.some((step) => !step.modifiers.some((modifier) => modifier !== "shift"))
      ) {
        throw new ShortcutConfigError(
          `shortcut "${actionId}" allows input: every step of "${binding.spec}" must require Alt, Ctrl, or Cmd`,
        );
      }
      const matchPath = binding.steps.map((step) => step.token).join(" ");
      const previous = seen.get(matchPath);
      if (previous) {
        if (previous.input !== binding.input) {
          throw new ShortcutConfigError(
            `shortcut "${actionId}" repeats "${binding.spec}" with conflicting input rules`,
          );
        }
        continue;
      }
      seen.set(matchPath, binding);
      insertAliasPath(aliasRoot, binding, actionId, allowPrefixes);
      insertMatchPath(root, binding);
      compiled.push(binding);
    }

    bindings.set(actionId, compiled);
    signatureParts.push([
      actionId,
      compiled.map((binding) => [binding.input, binding.steps.map((step) => step.token)]),
    ]);
  }

  return { allowPrefixes, signature: JSON.stringify(signatureParts), bindings, root };
}

function formatCodeLabel(code: string) {
  if (KEY_CODE_PATTERN.test(code)) return code.slice(3);
  if (DIGIT_CODE_PATTERN.test(code)) return code.slice(5);
  const label = CODE_KEY_LABELS.get(code);
  if (label === " ") return "Space";
  return label ?? code;
}

function formatStepKey(step: ShortcutStep) {
  if (step.kind === "code") return formatCodeLabel(step.value);
  return step.value === " " ? "Space" : step.value;
}

function formatModifier(modifier: Modifier, altLabel?: string) {
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

function formatBinding(binding: CompiledBinding, options: ShortcutLabelOptions) {
  const bare =
    binding.steps.length > 0 &&
    binding.steps.every((step) => step.modifiers.length === 0 && formatStepKey(step).length === 1);
  if (options.compact && bare) {
    const keys = binding.steps.map((step) => formatStepKey(step));
    return binding.steps.length > 1
      ? keys.join(" then ").toLowerCase()
      : keys.join("").toUpperCase();
  }
  return binding.steps
    .map((step) => {
      const key = formatStepKey(step);
      if (step.modifiers.length === 0) return key.toUpperCase();
      const modifiers = step.modifiers.map((modifier) =>
        formatModifier(modifier, options.altLabel),
      );
      return `${modifiers.join("+")}+${key}`;
    })
    .join(" then ");
}

function eventTokens(event: ShortcutKeyboardEvent) {
  const mask =
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return { code: `${mask}#code#${event.code}`, key: `${mask}#key#${key}` };
}

function advance(nodes: readonly ShortcutTrieNode[], event: ShortcutKeyboardEvent) {
  const tokens = eventTokens(event);
  const next: ShortcutTrieNode[] = [];
  for (const node of nodes) {
    const byCode = node.next.get(tokens.code);
    if (byCode) next.push(byCode);
    const byKey = node.next.get(tokens.key);
    if (byKey) next.push(byKey);
  }
  return next;
}

function reportToConsole(error: unknown) {
  console.error("[shortcuts] handler failed", error);
}

export function createShortcutRegistry(options: {
  catalog: ShortcutCatalog;
  overrides?: unknown;
  allowPrefixes?: boolean;
  sequenceTimeoutMs?: number;
  onError?: (error: unknown) => void;
}): ShortcutRegistry {
  const { catalog, allowPrefixes = false } = options;
  const sequenceTimeoutMs = options.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
  if (!Number.isFinite(sequenceTimeoutMs) || sequenceTimeoutMs <= 0) {
    throw new ShortcutConfigError("sequenceTimeoutMs must be a finite positive number");
  }
  const reportError = options.onError ?? reportToConsole;
  let compiled = compileShortcutBindings(catalog, options.overrides, { allowPrefixes });

  const registrations = new Map<string, Map<string, ShortcutHandler>>();
  const listeners = new Set<() => void>();
  let pending: { nodes: readonly ShortcutTrieNode[]; event: ShortcutKeyboardEvent } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function selectHandler(
    binding: CompiledBinding,
    event: ShortcutKeyboardEvent,
    inputFocused: boolean,
  ): ShortcutHandler | null {
    const { actionId } = binding;
    const definition = getDefinition(catalog, actionId);
    if (!definition) return null;
    if (event.repeat && definition.repeat !== true) return null;
    if (inputFocused && binding.input === "ignore") return null;
    for (const owner of definition.owners) {
      const handler = registrations.get(owner)?.get(actionId);
      if (!handler) continue;
      if (typeof handler.enabled !== "function") {
        if (handler.enabled !== false) return handler;
        continue;
      }
      try {
        if (handler.enabled(event)) return handler;
      } catch (error) {
        reportError(error);
        return null;
      }
    }
    return null;
  }

  function selectAction(
    nodes: readonly ShortcutTrieNode[],
    event: ShortcutKeyboardEvent,
    inputFocused: boolean,
  ) {
    let selectedAction: string | null = null;
    let selectedHandler: ShortcutHandler | null = null;
    for (const node of nodes) {
      if (!node.binding || node.binding.actionId === selectedAction) continue;
      const handler = selectHandler(node.binding, event, inputFocused);
      if (!handler) continue;
      if (selectedAction !== null) {
        reportError(
          new ShortcutConfigError(
            `Keyboard layout makes shortcuts "${selectedAction}" and "${node.binding.actionId}" overlap`,
          ),
        );
        return null;
      }
      selectedAction = node.binding.actionId;
      selectedHandler = handler;
    }
    return selectedHandler;
  }

  function runHandler(handler: ShortcutHandler, event: ShortcutKeyboardEvent) {
    try {
      handler.run(event);
    } catch (error) {
      reportError(error);
    }
  }

  function clearTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function cancelPending() {
    pending = null;
    clearTimer();
  }

  function closePending(inputFocused: boolean) {
    const current = pending;
    cancelPending();
    if (!current) return;
    const handler = selectAction(current.nodes, current.event, inputFocused);
    if (handler) runHandler(handler, current.event);
  }

  function armTimer(inputFocused: boolean) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      closePending(inputFocused);
    }, sequenceTimeoutMs);
  }

  function resolvesNow(nodes: readonly ShortcutTrieNode[]) {
    for (const node of nodes) {
      if (node.next.size > 0) return false;
      if (allowPrefixes && node.depth > 1) return false;
    }
    return nodes.some((node) => node.binding !== null);
  }

  function hasEligibleOwner(
    nodes: readonly ShortcutTrieNode[],
    event: ShortcutKeyboardEvent,
    inputFocused: boolean,
  ) {
    for (const node of nodes) {
      for (const binding of node.reachable) {
        if (selectHandler(binding, event, inputFocused)) return true;
      }
    }
    return false;
  }

  function continueSequence(event: ShortcutKeyboardEvent, inputFocused: boolean) {
    const current = pending;
    if (!current) return false;
    if (event.repeat) {
      event.preventDefault();
      return true;
    }

    const nodes = advance(current.nodes, event);
    current.nodes = nodes;
    current.event = event;
    event.preventDefault();

    if (resolvesNow(nodes)) {
      cancelPending();
      const handler = selectAction(nodes, event, inputFocused);
      if (handler) runHandler(handler, event);
      return true;
    }

    armTimer(inputFocused);
    return true;
  }

  function startGesture(event: ShortcutKeyboardEvent, inputFocused: boolean) {
    const nodes = advance([compiled.root], event);
    if (nodes.length === 0) return false;

    if (resolvesNow(nodes)) {
      const handler = selectAction(nodes, event, inputFocused);
      if (!handler) return false;
      event.preventDefault();
      runHandler(handler, event);
      return true;
    }

    if (event.repeat) return false;
    if (!hasEligibleOwner(nodes, event, inputFocused)) return false;
    event.preventDefault();
    pending = { nodes, event };
    armTimer(inputFocused);
    return true;
  }

  return {
    register(owner, handlers) {
      if (typeof owner !== "string" || owner.length === 0) {
        throw new ShortcutConfigError("shortcut owner must be a non-empty string");
      }
      const entries = Object.entries(handlers);
      const existing = registrations.get(owner);
      for (const [actionId, handler] of entries) {
        const definition = getDefinition(catalog, actionId);
        if (!definition) {
          throw new ShortcutConfigError(`owner "${owner}" registered unknown action "${actionId}"`);
        }
        if (!definition.owners.includes(owner)) {
          throw new ShortcutConfigError(`action "${actionId}" is not owned by "${owner}"`);
        }
        if (typeof handler?.run !== "function") {
          throw new ShortcutConfigError(`action "${actionId}" handler needs a run function`);
        }
        if (existing?.has(actionId)) {
          throw new ShortcutConfigError(`owner "${owner}" already registered "${actionId}"`);
        }
        if (
          handler.enabled !== undefined &&
          typeof handler.enabled !== "boolean" &&
          typeof handler.enabled !== "function"
        ) {
          throw new ShortcutConfigError(
            `action "${actionId}" enabled must be a boolean or a predicate`,
          );
        }
      }

      const bucket = existing ?? new Map<string, ShortcutHandler>();
      registrations.set(owner, bucket);
      for (const [actionId, handler] of entries) bucket.set(actionId, handler);
      cancelPending();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const [actionId, handler] of entries) {
          if (bucket.get(actionId) === handler) bucket.delete(actionId);
        }
        if (bucket.size === 0 && registrations.get(owner) === bucket) registrations.delete(owner);
        cancelPending();
      };
    },

    setOverrides(overrides) {
      const next = compileShortcutBindings(catalog, overrides, { allowPrefixes });
      if (next.signature === compiled.signature) return;
      compiled = next;
      cancelPending();
      for (const listener of listeners) listener();
    },

    handleKeyDown(event, inputFocused = false) {
      if (event.defaultPrevented || event.isComposing || event.key === "Process") {
        cancelPending();
        return false;
      }
      if (MODIFIER_ONLY_KEYS.has(event.key)) return false;
      if (inputFocused && !(event.altKey || event.ctrlKey || event.metaKey)) {
        cancelPending();
        return false;
      }
      if (pending) return continueSequence(event, inputFocused);
      return startGesture(event, inputFocused);
    },

    getLabel(actionId, labelOptions = {}) {
      const binding = compiled.bindings.get(actionId)?.[0];
      return binding ? formatBinding(binding, labelOptions) : "";
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reset: cancelPending,

    dispose() {
      cancelPending();
      registrations.clear();
      listeners.clear();
    },
  };
}
