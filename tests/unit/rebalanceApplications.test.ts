import test from "node:test";
import assert from "node:assert/strict";

import { rebalanceApplications } from "../../src/services/rebalanceApplications.js";

const rows = [
  { id: "a1", user_id: "u1", priority: 3, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "a2", user_id: "u1", priority: 1, created_at: "2026-01-02T00:00:00.000Z" },
  { id: "a3", user_id: "u1", priority: 2, created_at: "2026-01-03T00:00:00.000Z" },
  { id: "a4", user_id: "u1", priority: null, created_at: "2026-01-04T00:00:00.000Z" },
  { id: "b1", user_id: "u2", priority: 1, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "b2", user_id: "u2", priority: 1, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "b3", user_id: "u2", priority: 2, created_at: "2026-01-01T00:00:00.000Z" },
];

test("rebalanceApplications keeps top-N per user and compacts priorities", () => {
  const plan = rebalanceApplications(rows, 2);

  assert.deepEqual(new Set(plan.deletedIds), new Set(["a1", "a4", "b3"]));
  assert.deepEqual(
    new Set(plan.updates.map((u) => `${u.id}:${u.priority}`)),
    new Set(["b2:2"])
  );
});

test("rebalanceApplications handles tie-break by created_at then id", () => {
  const tied = [
    { id: "x2", user_id: "uX", priority: 1, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "x1", user_id: "uX", priority: 1, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "x3", user_id: "uX", priority: 1, created_at: "2026-01-02T00:00:00.000Z" },
  ];

  const plan = rebalanceApplications(tied, 2);
  assert.deepEqual(plan.deletedIds, ["x3"]);
  assert.deepEqual(
    plan.updates,
    [{ id: "x2", priority: 2 }]
  );
});

test("rebalanceApplications validates newMax", () => {
  assert.throws(() => rebalanceApplications([], 0), /newMax must be >= 1/);
});
