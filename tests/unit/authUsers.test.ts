import test from "node:test";
import assert from "node:assert/strict";

import {
    getOrInviteUserByEmail,
    normalizeEmailInput,
} from "../../src/services/authUsers.js";

test("normalizeEmailInput normalizes case, trims and strips outer quotes", () => {
    assert.equal(normalizeEmailInput("Pietro@Gmail.com"), "pietro@gmail.com");
    assert.equal(normalizeEmailInput('"pietro@gmail.com"'), "pietro@gmail.com");
    assert.equal(normalizeEmailInput("'pietro@gmail.com'"), "pietro@gmail.com");
    assert.equal(normalizeEmailInput('  "Pietro@Gmail.com"  '), "pietro@gmail.com");
});

test("normalizeEmailInput throws 400 when value is empty after normalization", () => {
    assert.throws(
        () => normalizeEmailInput('""'),
        (error: any) =>
            Number(error?.status) === 400 &&
            String(error?.message ?? "").includes("Email address is required")
    );
});

test("getOrInviteUserByEmail returns existing user without sending invite", async () => {
    let inviteCalls = 0;
    const authAdmin = {
        listUsers: async () => ({
            data: {
                users: [
                    { id: "user-123", email: "pietro@gmail.com" },
                    { id: "user-999", email: "other@example.com" },
                ],
            },
            error: null,
        }),
        inviteUserByEmail: async () => {
            inviteCalls += 1;
            return { data: { user: null }, error: null };
        },
    };

    const result = await getOrInviteUserByEmail({
        authAdmin,
        email: "pietro@gmail.com",
        metadata: { full_name: "Pietro Rossi" },
    });

    assert.deepEqual(result, { userId: "user-123", source: "existing" });
    assert.equal(inviteCalls, 0);
});

test("getOrInviteUserByEmail maps invalid email invite error to 400", async () => {
    const authAdmin = {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        inviteUserByEmail: async () => ({
            data: null,
            error: { message: `Email address '"pietro@gmail.com"' is invalid` },
        }),
    };

    await assert.rejects(
        () =>
            getOrInviteUserByEmail({
                authAdmin,
                email: '"pietro@gmail.com"',
            }),
        (error: any) =>
            Number(error?.status) === 400 &&
            String(error?.message ?? "").includes("Invalid email address")
    );
});
