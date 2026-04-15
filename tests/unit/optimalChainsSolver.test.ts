import test from "node:test";
import assert from "node:assert/strict";

import {
  solveOptimalChains,
  type ChainCandidate,
  type OptimizationStrategy,
} from "../../../job-ixl-frontend/src/lib/optimalChainsSolver.ts";

function run(candidates: ChainCandidate[], strategy: OptimizationStrategy) {
  return solveOptimalChains(candidates, strategy).selectedChains.map((c) => c.id);
}

test("solver selects only disjoint chains", () => {
  const candidates: ChainCandidate[] = [
    { id: "A", nodeIds: ["u1", "u2"], avgPriority: 1.5, sumPriority: 3, length: 2 },
    { id: "B", nodeIds: ["u2", "u3"], avgPriority: 1.2, sumPriority: 2.4, length: 2 },
    { id: "C", nodeIds: ["u4", "u5"], avgPriority: 2, sumPriority: 4, length: 2 },
  ];

  const selected = run(candidates, "MAX_IMPACT");
  assert.deepEqual(new Set(selected), new Set(["B", "C"]));
});

test("solver MAX_IMPACT prefers higher count before quality", () => {
  const candidates: ChainCandidate[] = [
    { id: "big", nodeIds: ["u1", "u2", "u3"], avgPriority: 1, sumPriority: 3, length: 3 },
    { id: "s1", nodeIds: ["u1"], avgPriority: 2, sumPriority: 2, length: 1 },
    { id: "s2", nodeIds: ["u2"], avgPriority: 2, sumPriority: 2, length: 1 },
    { id: "s3", nodeIds: ["u3"], avgPriority: 2, sumPriority: 2, length: 1 },
  ];

  const selected = run(candidates, "MAX_IMPACT");
  assert.deepEqual(new Set(selected), new Set(["s1", "s2", "s3"]));
});

test("solver QUALITY_FIRST prefers lower avg priority", () => {
  const candidates: ChainCandidate[] = [
    { id: "left", nodeIds: ["u1", "u2"], avgPriority: 2, sumPriority: 4, length: 2 },
    { id: "right", nodeIds: ["u3", "u4"], avgPriority: 2, sumPriority: 4, length: 2 },
    { id: "gold", nodeIds: ["u1", "u2", "u3", "u4"], avgPriority: 1.5, sumPriority: 6, length: 4 },
  ];

  const selected = run(candidates, "QUALITY_FIRST");
  assert.deepEqual(selected, ["gold"]);
});

test("solver handles empty candidates", () => {
  const out = solveOptimalChains([], "MAX_IMPACT");
  assert.deepEqual(out.selectedChains, []);
  assert.equal(out.stats.count, 0);
  assert.equal(out.stats.exploredStates, 1);
  assert.equal(out.stats.avgPriority, Number.POSITIVE_INFINITY);
});
