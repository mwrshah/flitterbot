import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_CATALOG, SHORTCUT_OPTIONS } from "./shortcuts/catalog.ts";
import { compileShortcutBindings } from "./shortcuts/registry.ts";

test("product defaults compile without conflicting bindings", () => {
  assert.doesNotThrow(() => compileShortcutBindings(SHORTCUT_CATALOG, {}, SHORTCUT_OPTIONS));
});
