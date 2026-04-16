import test from "node:test";
import assert from "node:assert/strict";

import { applicationsRouter } from "../../src/routes/applications.js";
import { usersRouter } from "../../src/routes/users.js";
import { adminRouter } from "../../src/routes/admin.js";
import {
  __getInvalidateMapCacheCallsForTests,
  __resetInvalidateMapCacheCallsForTests,
} from "../../src/routes/map.js";
import { createDbState, installDbHarness, invokeRoute } from "./_harness.js";

function makeAccessContext(overrides: Record<string, unknown> = {}) {
  return {
    requestedCompanyId: "c1",
    requestedPerimeterId: "p1",
    currentCompanyId: "c1",
    currentCompanyName: "Company",
    currentPerimeterId: "p1",
    currentPerimeterName: "Perimeter",
    isOwner: false,
    isCompanySuperAdmin: false,
    isPerimeterAdmin: false,
    canAccessCompany: true,
    canAccessPerimeter: true,
    canManageCompany: false,
    canManagePerimeter: false,
    accessRole: "user",
    highestRole: "user",
    companies: [],
    perimeters: [],
    ...overrides,
  };
}

test("POST /api/users/:userId/applications/bulk applies rows, recalculates application_count, invalidates cache", async () => {
  const state = createDbState({
    app_config: [{ company_id: "c1", perimeter_id: "p1", max_applications: 3 }],
    perimeters: [{ id: "p1", campaign_status: "open" }],
    positions: [
      { id: "pos-1", occupied_by: "occ-1", company_id: "c1", perimeter_id: "p1" },
      { id: "pos-2", occupied_by: "occ-2", company_id: "c1", perimeter_id: "p1" },
    ],
    users: [
      { id: "u-1", company_id: "c1", perimeter_id: "p1", application_count: 0 },
      { id: "occ-1", company_id: "c1", perimeter_id: "p1", role_id: "role-A", location_id: "loc-A" },
      { id: "occ-2", company_id: "c1", perimeter_id: "p1", role_id: "role-A", location_id: "loc-A" },
    ],
  });

  const cleanup = installDbHarness(state);
  __resetInvalidateMapCacheCallsForTests();

  try {
    const res = await invokeRoute({
      router: applicationsRouter,
      method: "post",
      path: "/users/:userId/applications/bulk",
      req: {
        params: { userId: "u-1" },
        body: { positionIds: ["pos-1", "pos-2"], priority: 1 },
        headers: {
          authorization: "Bearer test-token",
          "x-test-user-id": "u-1",
        },
        user: { id: "u-1" },
        accessContext: makeAccessContext(),
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.ok, true);
    assert.equal(state.applications.length, 2);
    const user = state.users.find((u) => u.id === "u-1");
    assert.equal(user?.application_count, 1);
    assert.equal(__getInvalidateMapCacheCallsForTests(), 1);
  } finally {
    cleanup();
  }
});

test("DELETE /api/users/:userId/applications/bulk withdraws rows, recalculates application_count, invalidates cache", async () => {
  const state = createDbState({
    app_config: [{ company_id: "c1", perimeter_id: "p1", max_applications: 3 }],
    positions: [
      { id: "pos-1", occupied_by: "occ-1", company_id: "c1", perimeter_id: "p1" },
      { id: "pos-2", occupied_by: "occ-2", company_id: "c1", perimeter_id: "p1" },
    ],
    users: [
      { id: "u-1", company_id: "c1", perimeter_id: "p1", application_count: 1 },
      { id: "occ-1", company_id: "c1", perimeter_id: "p1", role_id: "role-A", location_id: "loc-A" },
      { id: "occ-2", company_id: "c1", perimeter_id: "p1", role_id: "role-A", location_id: "loc-A" },
    ],
    applications: [
      {
        id: "a-1",
        user_id: "u-1",
        position_id: "pos-1",
        priority: 1,
        company_id: "c1",
        perimeter_id: "p1",
      },
      {
        id: "a-2",
        user_id: "u-1",
        position_id: "pos-2",
        priority: 1,
        company_id: "c1",
        perimeter_id: "p1",
      },
    ],
  });

  const cleanup = installDbHarness(state);
  __resetInvalidateMapCacheCallsForTests();

  try {
    const res = await invokeRoute({
      router: applicationsRouter,
      method: "delete",
      path: "/users/:userId/applications/bulk",
      req: {
        params: { userId: "u-1" },
        body: { positionIds: ["pos-1", "pos-2"] },
        headers: {
          authorization: "Bearer test-token",
          "x-test-user-id": "u-1",
        },
        user: { id: "u-1" },
        accessContext: makeAccessContext(),
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.ok, true);
    assert.equal(state.applications.length, 0);
    const user = state.users.find((u) => u.id === "u-1");
    assert.equal(user?.application_count, 0);
    assert.equal(__getInvalidateMapCacheCallsForTests(), 1);
  } finally {
    cleanup();
  }
});

test("POST /api/users/:userId/reorder-applications updates priorities and invalidates cache", async () => {
  const state = createDbState({
    app_config: [{ company_id: "c1", perimeter_id: "p1", max_applications: 3 }],
    users: [{ id: "u-1", company_id: "c1", perimeter_id: "p1", application_count: 2 }],
    applications: [
      {
        id: "a-1",
        user_id: "u-1",
        position_id: "pos-1",
        priority: 1,
        company_id: "c1",
        perimeter_id: "p1",
      },
      {
        id: "a-2",
        user_id: "u-1",
        position_id: "pos-2",
        priority: 2,
        company_id: "c1",
        perimeter_id: "p1",
      },
    ],
  });

  const cleanup = installDbHarness(state);
  __resetInvalidateMapCacheCallsForTests();

  try {
    const res = await invokeRoute({
      router: usersRouter,
      method: "post",
      path: "/:userId/reorder-applications",
      req: {
        params: { userId: "u-1" },
        body: {
          updates: [{ app_ids: ["a-1", "a-2"], priority: 3 }],
        },
        headers: {},
        user: { id: "u-1" },
        accessContext: makeAccessContext(),
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.ok, true);
    assert.deepEqual(
      state.applications.map((a) => ({ id: a.id, priority: a.priority })),
      [
        { id: "a-1", priority: 3 },
        { id: "a-2", priority: 3 },
      ]
    );
    assert.equal(__getInvalidateMapCacheCallsForTests(), 1);
  } finally {
    cleanup();
  }
});

test("POST /api/admin/users/:id/deactivate cleans applications and recalculates impacted users", async () => {
  const state = createDbState({
    users: [
      {
        id: "u-target",
        company_id: "c1",
        perimeter_id: "p1",
        availability_status: "available",
        application_count: 1,
      },
      {
        id: "u-affected",
        company_id: "c1",
        perimeter_id: "p1",
        availability_status: "available",
        application_count: 1,
      },
      { id: "occ-x", company_id: "c1", perimeter_id: "p1", role_id: "role-X", location_id: "loc-X" },
    ],
    positions: [
      { id: "pos-target", occupied_by: "u-target", company_id: "c1", perimeter_id: "p1" },
      { id: "pos-other", occupied_by: "occ-x", company_id: "c1", perimeter_id: "p1" },
    ],
    applications: [
      {
        id: "app-out",
        user_id: "u-target",
        position_id: "pos-other",
        priority: 1,
        company_id: "c1",
        perimeter_id: "p1",
      },
      {
        id: "app-in",
        user_id: "u-affected",
        position_id: "pos-target",
        priority: 1,
        company_id: "c1",
        perimeter_id: "p1",
      },
    ],
  });

  const cleanup = installDbHarness(state);
  __resetInvalidateMapCacheCallsForTests();

  try {
    const res = await invokeRoute({
      router: adminRouter,
      method: "post",
      path: "/users/:id/deactivate",
      req: {
        params: { id: "u-target" },
        body: {},
        headers: {},
        user: { id: "admin-1" },
        accessContext: makeAccessContext({ canManagePerimeter: true, isPerimeterAdmin: true, accessRole: "admin_user" }),
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.ok, true);
    assert.equal(state.applications.length, 0);

    const target = state.users.find((u) => u.id === "u-target");
    const affected = state.users.find((u) => u.id === "u-affected");

    assert.equal(target?.availability_status, "inactive");
    assert.equal(target?.application_count, 0);
    assert.equal(affected?.application_count, 0);
    assert.equal(__getInvalidateMapCacheCallsForTests(), 1);
  } finally {
    cleanup();
  }
});
