import test from "node:test";
import assert from "node:assert/strict";
import { login, apiFetch } from "./_helpers.js";

test("health is public", async () => {
    const { res, json } = await apiFetch("/health", null);
    assert.equal(res.status, 200);
    assert.equal(json?.ok, true);
});

test("auth required endpoints reject missing token", async () => {
    const r2 = await apiFetch("/api/map/positions", null);
    assert.ok([401, 403].includes(r2.res.status));
});


test("admin middleware blocks non-admin even if route doesn't exist", async () => {
    const user = await login(process.env.TEST_USER_EMAIL, process.env.TEST_USER_PASSWORD);
    const nonAdmin = await apiFetch("/api/admin/__nonexistent", user.token);
    assert.equal(nonAdmin.res.status, 403);

    const admin = await login(process.env.TEST_ADMIN_EMAIL, process.env.TEST_ADMIN_PASSWORD);
    const adminHit = await apiFetch("/api/admin/__nonexistent", admin.token);
    // admin passa RBAC e poi prende 404 perché route non esiste
    assert.equal(adminHit.res.status, 404);
});


test("error shape includes correlationId", async () => {
    const r = await apiFetch("/api/admin/__nonexistent", null);
    // senza token -> 401/403
    const { json } = r;
    assert.equal(typeof json?.correlationId, "string");
    assert.equal(json?.ok, false);
    assert.ok(json?.error?.code);
});
