import test from "node:test";
import assert from "node:assert/strict";

import { isOperationalPerimeterAdmin } from "../../src/services/operationalPerimeterAdmin.js";

test("allows admin_user with direct active perimeter membership in current scope", () => {
  const allowed = isOperationalPerimeterAdmin({
    currentCompanyId: "company-a",
    currentPerimeterId: "perimeter-1",
    perimeters: [
      { company_id: "company-a", perimeter_id: "perimeter-1", access_role: "admin_user" },
    ],
  });

  assert.equal(allowed, true);
});

test("denies normal user in current perimeter", () => {
  const allowed = isOperationalPerimeterAdmin({
    currentCompanyId: "company-a",
    currentPerimeterId: "perimeter-1",
    perimeters: [
      { company_id: "company-a", perimeter_id: "perimeter-1", access_role: "user" },
    ],
  });

  assert.equal(allowed, false);
});

test("denies owner/super-admin style context without direct perimeter membership", () => {
  const allowed = isOperationalPerimeterAdmin({
    currentCompanyId: "company-a",
    currentPerimeterId: "perimeter-1",
    perimeters: [],
  });

  assert.equal(allowed, false);
});

test("denies admin membership from another perimeter", () => {
  const allowed = isOperationalPerimeterAdmin({
    currentCompanyId: "company-a",
    currentPerimeterId: "perimeter-1",
    perimeters: [
      { company_id: "company-a", perimeter_id: "perimeter-2", access_role: "admin" },
    ],
  });

  assert.equal(allowed, false);
});
