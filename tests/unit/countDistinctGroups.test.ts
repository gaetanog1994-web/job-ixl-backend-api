import test from "node:test";
import assert from "node:assert/strict";

import { countDistinctGroups } from "../../src/services/countDistinctGroups.js";

test("countDistinctGroups counts distinct (role_id, location_id) groups", () => {
  const count = countDistinctGroups({
    positionIds: ["p1", "p2", "p3", "p4"],
    positions: [
      { id: "p1", occupied_by: "uA" },
      { id: "p2", occupied_by: "uB" },
      { id: "p3", occupied_by: "uC" },
      { id: "p4", occupied_by: "uD" },
    ],
    occupants: [
      { id: "uA", role_id: "r1", location_id: "l1" },
      { id: "uB", role_id: "r1", location_id: "l1" },
      { id: "uC", role_id: "r2", location_id: "l1" },
      { id: "uD", role_id: "r2", location_id: "l2" },
    ],
  });

  assert.equal(count, 3);
});

test("countDistinctGroups is stable with duplicates and unknown refs", () => {
  const count = countDistinctGroups({
    positionIds: ["p1", "p1", "p2", "missing", "", null],
    positions: [
      { id: "p1", occupied_by: "uA" },
      { id: "p2", occupied_by: null },
    ],
    occupants: [{ id: "uA", role_id: "r1", location_id: "l1" }],
  });

  assert.equal(count, 1);
});

test("countDistinctGroups returns 0 for empty or unresolved inputs", () => {
  assert.equal(
    countDistinctGroups({ positionIds: [], positions: [], occupants: [] }),
    0
  );

  assert.equal(
    countDistinctGroups({
      positionIds: ["p1"],
      positions: [{ id: "p1", occupied_by: "ghost" }],
      occupants: [],
    }),
    0
  );
});
