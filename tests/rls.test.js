import test from "node:test";
import assert from "node:assert/strict";
import { login } from "./_helpers.js";

test("RLS users: non-admin sees only own row", async () => {
    const { sb, userId } = await login(process.env.TEST_USER_EMAIL, process.env.TEST_USER_PASSWORD);

    const { data, error } = await sb.from("users").select("id,email").limit(10);
    assert.equal(error, null);

    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].id, userId);
});

test("users column privileges: non-admin cannot update fixed_location", async () => {
    const { sb, userId } = await login(process.env.TEST_USER_EMAIL, process.env.TEST_USER_PASSWORD);

    const { error } = await sb.from("users")
        .update({ fixed_location: true })
        .eq("id", userId);

    assert.ok(error, "expected error updating fixed_location");
});

test("users: non-admin can update availability_status", async () => {
    const { sb, userId } = await login(process.env.TEST_USER_EMAIL, process.env.TEST_USER_PASSWORD);

    const { error } = await sb.from("users")
        .update({ availability_status: "inactive" })
        .eq("id", userId);

    assert.equal(error, null);
});

test("RLS applications: non-admin cannot insert for another user_id", async () => {
    const { sb, userId } = await login(process.env.TEST_USER_EMAIL, process.env.TEST_USER_PASSWORD);

    const otherUserId = "d25a7298-4531-449b-8ec7-b5d7de2787ab"; // Gaetano id (admin) dal tuo export
    assert.notEqual(otherUserId, userId);

    const { error } = await sb.from("applications").insert({
        user_id: otherUserId,
        position_id: "d0282c4e-f379-4393-9c2f-b38471d05aba",
        priority: 1,
    });

    assert.ok(error, "expected RLS error inserting for another user");
});
