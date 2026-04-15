import test from "node:test";
import assert from "node:assert/strict";

import { planDeactivateCleanup } from "../../src/services/deactivateCleanup.js";

test("planDeactivateCleanup selects incoming applications and affected users", () => {
  const plan = planDeactivateCleanup("u-deactivated", [
    { id: "app-1", user_id: "uA" },
    { id: "app-2", user_id: "uA" },
    { id: "app-3", user_id: "uB" },
    { id: "app-4", user_id: "u-deactivated" },
  ]);

  assert.deepEqual(plan.incomingApplicationIds, ["app-1", "app-2", "app-3", "app-4"]);
  assert.deepEqual(new Set(plan.affectedUserIds), new Set(["uA", "uB"]));
});

test("planDeactivateCleanup handles empty input", () => {
  const plan = planDeactivateCleanup("u-deactivated", []);
  assert.deepEqual(plan.incomingApplicationIds, []);
  assert.deepEqual(plan.affectedUserIds, []);
});
