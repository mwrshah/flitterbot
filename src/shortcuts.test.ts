import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileShortcutBindings,
  createShortcutRegistry,
  type ShortcutCatalog,
  ShortcutConfigError,
  type ShortcutKeyboardEvent,
} from "./shortcuts/registry.ts";

const CATALOG: ShortcutCatalog = {
  open: { bindings: [{ keys: "Alt+KeyR" }], owners: ["panel", "app"] },
  top: { bindings: [{ keys: "g g", input: "ignore" }], owners: ["app"] },
  down: { bindings: [{ keys: "j", input: "ignore" }], owners: ["app"], repeat: true },
};

function key(key: string, init: Partial<ShortcutKeyboardEvent> = {}): ShortcutKeyboardEvent {
  const event = {
    key,
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...init,
  };
  return event;
}

const openKey = () => key("r", { altKey: true });

test("configuration rejects malformed, unknown, duplicate and default-prefix bindings", () => {
  for (const overrides of [
    null,
    [],
    { missing: "x" },
    { open: 7 },
    { open: [null] },
    { open: "Alt+KeyR" },
    { open: [{ keys: "Alt+KeyR", input: "sometimes" }] },
    { open: [{ keys: "Alt+KeyR" }, { keys: "Alt+KeyR", input: "ignore" }] },
    { open: [{ keys: "" }] },
    { open: [{ keys: "Alt+" }] },
    { open: [{ keys: "Hyper+KeyR" }] },
    { top: [{ keys: "j", input: "ignore" }] },
    { down: [{ keys: "g", input: "ignore" }] },
    { open: [{ keys: "g" }] },
    { open: [{ keys: "Shift+KeyR" }] },
    { open: [{ keys: "Ctrl+KeyK c" }] },
    JSON.parse('{"__proto__":"x"}'),
  ]) {
    assert.throws(() => compileShortcutBindings(CATALOG, overrides), ShortcutConfigError);
  }
  assert.doesNotThrow(() =>
    compileShortcutBindings(
      CATALOG,
      { down: [{ keys: "g", input: "ignore" }] },
      { allowPrefixes: true },
    ),
  );
  for (const input of [undefined, "allow"] as const) {
    assert.throws(
      () =>
        createShortcutRegistry({
          catalog: {
            invalid: { bindings: [{ keys: "f", input: input }], owners: ["app"] },
          },
        }),
      ShortcutConfigError,
    );
  }
});

test("override updates replace dispatch and labels atomically; disabling removes both", (t) => {
  const registry = createShortcutRegistry({ catalog: CATALOG });
  t.after(() => registry.dispose());
  let runs = 0;
  let notifications = 0;
  registry.register("app", { open: { run: () => runs++ } });
  registry.subscribe(() => notifications++);
  registry.setOverrides({ open: [{ keys: "Ctrl+KeyR" }] });
  assert.equal(registry.getLabel("open"), "Ctrl+R");
  assert.equal(registry.handleKeyDown(openKey()), false);
  assert.equal(registry.handleKeyDown(key("r", { ctrlKey: true })), true);
  assert.equal(runs, 1);
  assert.throws(() => registry.setOverrides({ open: [{ keys: "Alt+" }] }), ShortcutConfigError);
  assert.equal(registry.getLabel("open"), "Ctrl+R");
  assert.equal(notifications, 1);
  registry.handleKeyDown(key("r", { ctrlKey: true }));
  assert.equal(runs, 2);
  registry.setOverrides({ open: [] });
  assert.equal(registry.getLabel("open"), "");
  const event = key("r", { ctrlKey: true });
  assert.equal(registry.handleKeyDown(event), false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(runs, 2);
});

test("catalog order selects one enabled owner; failures never execute the fallback", (t) => {
  const errors: unknown[] = [];
  const calls: string[] = [];
  const registry = createShortcutRegistry({
    catalog: CATALOG,
    onError: (error) => errors.push(error),
  });
  t.after(() => registry.dispose());
  let state: "disabled" | "enabled" | "predicate-error" | "run-error" = "disabled";
  registry.register("panel", {
    open: {
      enabled: () => {
        if (state === "predicate-error") throw new Error("predicate failed");
        return state !== "disabled";
      },
      run: () => {
        if (state === "run-error") throw new Error("handler failed");
        calls.push("panel");
      },
    },
  });
  registry.register("app", { open: { run: () => calls.push("app") } });
  for (state of ["disabled", "enabled", "predicate-error", "run-error"] as const) {
    registry.handleKeyDown(openKey());
  }
  assert.deepEqual(calls, ["app", "panel"]);
  assert.equal(errors.length, 2);
});

test("registration is atomic, rejects duplicate owners, and stale cleanup cannot remove a successor", (t) => {
  const registry = createShortcutRegistry({ catalog: CATALOG });
  t.after(() => registry.dispose());
  let runs = 0;
  const handlers = { open: { run: () => runs++ } };
  assert.throws(() => registry.register("app", { ...handlers, missing: handlers.open }));
  assert.equal(registry.handleKeyDown(openKey()), false);
  assert.throws(() => registry.register("outsider", handlers));
  const release = registry.register("app", handlers);
  assert.throws(() => registry.register("app", handlers));
  release();
  registry.register("app", handlers);
  release();
  registry.handleKeyDown(openKey());
  assert.equal(runs, 1);
});

test("typing and repeat policies consume only eligible shortcuts", (t) => {
  const registry = createShortcutRegistry({ catalog: CATALOG });
  t.after(() => registry.dispose());
  let runs = 0;
  registry.register("app", { open: { run: () => runs++ }, down: { run: () => runs++ } });
  registry.setOverrides({
    open: [
      { keys: "Alt+KeyR" },
      { keys: "r", input: "ignore" },
      { keys: "Ctrl+KeyR", input: "ignore" },
    ],
  });
  for (const [event, inputFocused, consumed] of [
    [key("j"), true, false],
    [openKey(), true, true],
    [key("r"), true, false],
    [key("r"), false, true],
    [key("r", { ctrlKey: true }), true, false],
    [key("r", { ctrlKey: true }), false, true],
    [key("j", { repeat: true }), false, true],
    [key("r", { altKey: true, repeat: true }), false, false],
    [key("x"), false, false],
  ] as const) {
    assert.equal(registry.handleKeyDown(event, inputFocused), consumed);
    assert.equal(event.defaultPrevented, consumed);
  }
  assert.throws(
    () => registry.setOverrides({ open: [{ keys: "Shift+KeyR" }] }),
    ShortcutConfigError,
  );
  registry.setOverrides({ down: [{ keys: "Ctrl+KeyJ", input: "ignore" }] });
  assert.equal(registry.handleKeyDown(key("j", { ctrlKey: true }), true), false);
  assert.equal(registry.handleKeyDown(key("j", { ctrlKey: true })), true);
  assert.equal(runs, 5);
  registry.setOverrides({ open: [{ keys: "Alt+KeyR" }, { keys: "Ctrl+KeyK x", input: "ignore" }] });
  const prefix = key("k", { ctrlKey: true });
  assert.equal(registry.handleKeyDown(prefix, true), false);
  assert.equal(prefix.defaultPrevented, false);
});

test("prefix-free sequences finish at the leaf; held keys do not advance them", (t) => {
  const registry = createShortcutRegistry({ catalog: CATALOG });
  t.after(() => registry.dispose());
  let runs = 0;
  registry.register("app", { top: { run: () => runs++ } });
  registry.handleKeyDown(key("g"));
  const held = key("g", { repeat: true });
  registry.handleKeyDown(held);
  assert.equal(held.defaultPrevented, true);
  assert.equal(runs, 0);
  registry.handleKeyDown(key("g"));
  assert.equal(runs, 1);
});

test("prefix mode closes the entire buffer on inactivity, never a shorter match or suffix", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const catalog: ShortcutCatalog = {
    short: { bindings: [{ keys: "t a", input: "ignore" }], owners: ["app"] },
    long: { bindings: [{ keys: "t a a", input: "ignore" }], owners: ["app"] },
    tail: { bindings: [{ keys: "b", input: "ignore" }], owners: ["app"] },
  };
  const registry = createShortcutRegistry({ catalog, allowPrefixes: true, sequenceTimeoutMs: 300 });
  t.after(() => registry.dispose());
  const calls: string[] = [];
  let enabled = true;
  registry.register(
    "app",
    Object.fromEntries(
      Object.keys(catalog).map((action) => [
        action,
        {
          enabled: () => enabled,
          run: () => calls.push(action),
        },
      ]),
    ),
  );
  for (const [input, expected] of [
    ["ta", ["short"]],
    ["taa", ["long"]],
    ["taab", []],
    ["taxa", []],
  ] as const) {
    calls.length = 0;
    for (const character of input) {
      registry.handleKeyDown(key(character));
      t.mock.timers.tick(200);
      assert.deepEqual(calls, []);
    }
    t.mock.timers.tick(99);
    assert.deepEqual(calls, []);
    t.mock.timers.tick(1);
    assert.deepEqual(calls, expected);
  }
  registry.handleKeyDown(key("t"));
  registry.handleKeyDown(key("a"));
  enabled = false;
  t.mock.timers.tick(300);
  assert.deepEqual(calls, []);
});

test("cancellation and expiry prevent stale sequences from firing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = createShortcutRegistry({ catalog: CATALOG, sequenceTimeoutMs: 300 });
  t.after(() => registry.dispose());
  let runs = 0;
  registry.register("app", { top: { run: () => runs++ } });
  for (const cancel of [
    () => registry.reset(),
    () => t.mock.timers.tick(300),
    () => registry.handleKeyDown(key("g", { isComposing: true })),
    () => registry.handleKeyDown(key("g", { defaultPrevented: true })),
    () => registry.handleKeyDown(key("Process", { code: "KeyG" })),
    () => registry.register("panel", { open: { run() {} } })(),
    () => registry.setOverrides({ open: [] }),
    () => registry.dispose(),
  ]) {
    registry.reset();
    registry.handleKeyDown(key("g"));
    cancel();
    registry.handleKeyDown(key("g"));
    t.mock.timers.tick(300);
    assert.equal(runs, 0);
  }
});

test("equivalent config refreshes preserve pending input and do not notify subscribers", (t) => {
  const registry = createShortcutRegistry({
    catalog: CATALOG,
    overrides: { open: [{ keys: "Ctrl+KeyR" }] },
  });
  t.after(() => registry.dispose());
  let runs = 0;
  let notifications = 0;
  registry.register("app", { top: { run: () => runs++ } });
  registry.subscribe(() => notifications++);
  registry.handleKeyDown(key("g"));
  registry.setOverrides({ open: [{ keys: "Control+KeyR" }] });
  registry.handleKeyDown(key("g"));
  assert.equal(runs, 1);
  assert.equal(notifications, 0);
  registry.setOverrides({ open: [{ keys: "Ctrl+KeyR", input: "ignore" }] });
  assert.equal(notifications, 1, "an input-only change must replace the compiled bindings");
});

test("physical and character continuations both survive a shared prefix", (t) => {
  const registry = createShortcutRegistry({
    catalog: {
      physical: { bindings: [{ keys: "KeyQ a", input: "ignore" }], owners: ["app"] },
      character: { bindings: [{ keys: "q b", input: "ignore" }], owners: ["app"] },
    },
  });
  t.after(() => registry.dispose());
  const calls: string[] = [];
  registry.register("app", {
    physical: { run: () => calls.push("physical") },
    character: { run: () => calls.push("character") },
  });
  for (const tail of ["a", "b"]) {
    registry.handleKeyDown(key("q"));
    registry.handleKeyDown(key(tail));
  }
  assert.deepEqual(calls, ["physical", "character"]);
});

test("same-action code and character alternatives work across keyboard layouts", (t) => {
  const registry = createShortcutRegistry({
    catalog: {
      action: {
        bindings: [
          { keys: "q", input: "ignore" },
          { keys: "KeyQ", input: "ignore" },
        ],
        owners: ["app"],
      },
    },
  });
  t.after(() => registry.dispose());
  let runs = 0;
  registry.register("app", { action: { run: () => runs++ } });
  registry.handleKeyDown(key("x", { code: "KeyQ" }));
  registry.handleKeyDown(key("q", { code: "KeyX" }));
  assert.equal(runs, 2);
});

test("layout-induced ambiguity reports both actions instead of executing either", (t) => {
  const errors: unknown[] = [];
  const registry = createShortcutRegistry({
    catalog: {
      physical: { bindings: [{ keys: "KeyQ", input: "ignore" }], owners: ["app"] },
      character: { bindings: [{ keys: "a", input: "ignore" }], owners: ["app"] },
    },
    onError: (error) => errors.push(error),
  });
  t.after(() => registry.dispose());
  let runs = 0;
  registry.register("app", { physical: { run: () => runs++ }, character: { run: () => runs++ } });
  registry.handleKeyDown(key("a", { code: "KeyQ" }));
  assert.equal(runs, 0);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /physical/);
  assert.match(String(errors[0]), /character/);
});
