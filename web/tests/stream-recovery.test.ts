import assert from "node:assert/strict";
import test from "node:test";
import { getStreamRecoveryKind } from "../src/lib/stream-recovery.ts";

test("closed streams can be reopened", () => {
  assert.equal(getStreamRecoveryKind({ status: "closed" }), "closed");
});

test("open streams can be reopened only when their pi-session is dead", () => {
  assert.equal(getStreamRecoveryKind({ status: "open", piSessionStatus: "ended" }), "dead");
  assert.equal(getStreamRecoveryKind({ status: "open", piSessionStatus: "crashed" }), "dead");
  assert.equal(getStreamRecoveryKind({ status: "open", piSessionStatus: "active" }), undefined);
  assert.equal(
    getStreamRecoveryKind({ status: "open", piSessionStatus: "waiting_for_user" }),
    undefined,
  );
  assert.equal(getStreamRecoveryKind({ status: "open" }), undefined);
});
