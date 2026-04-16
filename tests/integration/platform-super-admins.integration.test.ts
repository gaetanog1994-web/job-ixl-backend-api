import test from "node:test";
import assert from "node:assert/strict";

import { platformRouter } from "../../src/routes/platform.js";
import { createDbState, installDbHarness, invokeRoute } from "./_harness.js";

function ownerAccessContext(overrides: Record<string, unknown> = {}) {
  return {
    requestedCompanyId: "c1",
    requestedPerimeterId: "p1",
    currentCompanyId: "c1",
    currentCompanyName: "Company",
    currentPerimeterId: "p1",
    currentPerimeterName: "Perimeter",
    isOwner: true,
    isCompanySuperAdmin: false,
    isPerimeterAdmin: false,
    canAccessCompany: true,
    canAccessPerimeter: true,
    canManageCompany: true,
    canManagePerimeter: true,
    accessRole: "admin_user",
    highestRole: "owner",
    companies: [],
    perimeters: [],
    ...overrides,
  };
}

test("POST /api/platform/companies/:companyId/super-admins reactivates membership for existing user", async () => {
  const state = createDbState({
    authUsers: [{ id: "user-existing", email: "existing@example.com" }],
    users: [
      {
        id: "user-existing",
        email: "existing@example.com",
        first_name: "Mario",
        last_name: "Rossi",
        full_name: "Mario Rossi",
        company_id: "c1",
        perimeter_id: "p1",
      },
    ],
    company_memberships: [
      { company_id: "c1", user_id: "user-existing", role: "super_admin", status: "inactive" },
    ],
  });

  const cleanup = installDbHarness(state);

  try {
    const res = await invokeRoute({
      router: platformRouter,
      method: "post",
      path: "/companies/:companyId/super-admins",
      req: {
        params: { companyId: "c1" },
        body: {
          first_name: "Mario",
          last_name: "Rossi",
          email: "existing@example.com",
        },
        headers: {},
        user: { id: "owner-1" },
        accessContext: ownerAccessContext(),
      },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body?.ok, true);
    assert.equal(res.body?.super_admin?.id, "user-existing");
    assert.equal(state.inviteCalls, 0);

    const membership = state.company_memberships.find(
      (m) => m.company_id === "c1" && m.user_id === "user-existing" && m.role === "super_admin"
    );
    assert.equal(membership?.status, "active");
  } finally {
    cleanup();
  }
});

test("POST /api/platform/companies/:companyId/super-admins normalizes quoted email", async () => {
  const state = createDbState();
  const cleanup = installDbHarness(state);

  try {
    const res = await invokeRoute({
      router: platformRouter,
      method: "post",
      path: "/companies/:companyId/super-admins",
      req: {
        params: { companyId: "c1" },
        body: {
          first_name: "Anna",
          last_name: "Bianchi",
          email: '"Anna.Bianchi@Example.com"',
        },
        headers: {},
        user: { id: "owner-1" },
        accessContext: ownerAccessContext(),
      },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body?.ok, true);
    assert.equal(res.body?.super_admin?.email, "anna.bianchi@example.com");

    const user = state.users.find((u) => u.id === res.body?.super_admin?.id);
    assert.equal(user?.email, "anna.bianchi@example.com");
  } finally {
    cleanup();
  }
});

test("POST /api/platform/companies/:companyId/super-admins returns 400 for invalid email", async () => {
  const state = createDbState({
    invalidInviteEmails: new Set(["invalid@example.com"]),
  });
  const cleanup = installDbHarness(state);

  try {
    const res = await invokeRoute({
      router: platformRouter,
      method: "post",
      path: "/companies/:companyId/super-admins",
      req: {
        params: { companyId: "c1" },
        body: {
          first_name: "Bad",
          last_name: "Email",
          email: "invalid@example.com",
        },
        headers: {},
        user: { id: "owner-1" },
        accessContext: ownerAccessContext(),
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(String(res.body?.error ?? "").includes("Invalid email address"), true);
  } finally {
    cleanup();
  }
});

test("POST /api/platform/companies/:companyId/super-admins returns 403 TENANT_SCOPE_MISMATCH on scope mismatch", async () => {
  const state = createDbState();
  const cleanup = installDbHarness(state);

  try {
    const res = await invokeRoute({
      router: platformRouter,
      method: "post",
      path: "/companies/:companyId/super-admins",
      req: {
        params: { companyId: "c2" },
        body: {
          first_name: "Scope",
          last_name: "Mismatch",
          email: "scope@example.com",
        },
        headers: {},
        user: { id: "owner-1" },
        accessContext: ownerAccessContext({ currentCompanyId: "c1" }),
      },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.code, "TENANT_SCOPE_MISMATCH");
  } finally {
    cleanup();
  }
});
