import test from "node:test";
import assert from "node:assert/strict";
import { login } from "./_helpers.js";

test("RLS applications: non-admin cannot insert for another user_id", async () => {
    const { sb, userId } = await login(process.env.TEST_USER_EMAIL, process.env.TEST_USER_PASSWORD);

    // prendi un position_id valido senza hardcode
    const { data: positions, error: posErr } = await sb.from("positions").select("id").limit(1);
    assert.equal(posErr, null);
    assert.ok(positions?.[0]?.id, "expected at least one position");
    const positionId = positions[0].id;

    const otherUserId = "00000000-0000-0000-0000-000000000000";
    assert.notEqual(otherUserId, userId);

    const { error } = await sb.from("applications").insert({
        user_id: otherUserId,
        position_id: positionId,
        priority: 1,
    });

    assert.ok(error, "expected RLS error inserting for another user");
});
