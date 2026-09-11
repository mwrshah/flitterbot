import assert from "node:assert/strict";
import test from "node:test";
import { getTokenDeleteEdit } from "../src/lib/text-input.ts";

test("token editing declines composition, handled events, and additional modifiers", () => {
  const deleteToken = { key: "w", code: "KeyW", ctrlKey: true };
  assert.ok(getTokenDeleteEdit(deleteToken, "hello", 5, 5));
  for (const event of [
    { ...deleteToken, ctrlKey: false },
    { ...deleteToken, shiftKey: true },
    { ...deleteToken, altKey: true },
    { ...deleteToken, metaKey: true },
    { ...deleteToken, isComposing: true },
    { ...deleteToken, key: "Process" },
    { ...deleteToken, nativeEvent: { isComposing: true } },
    { ...deleteToken, defaultPrevented: true },
  ]) {
    assert.equal(getTokenDeleteEdit(event, "hello", 5, 5), null);
  }
});
