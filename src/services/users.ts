/**
 * services/users.ts — shared user-lifecycle logic
 *
 * Functions here replace SQL SECURITY DEFINER functions that previously lived
 * in Supabase (deactivate_user_and_cleanup, reorder_user_applications).
 * All operations use withTx() for atomicity and explicit tenant scoping.
 */

import { withTx } from "../db.js";
import { invalidateMapCache } from "../routes/map.js";
import { planDeactivateCleanup } from "./deactivateCleanup.js";

export interface DeactivateResult {
    deactivatedUserId: string;
    outgoingDeleted: number;
    incomingDeleted: number;
    affectedUsersRecalculated: number;
}

/**
 * Deactivate a user and atomically clean up all related applications.
 *
 * Steps (in single transaction):
 * 1. Delete outgoing applications (this user applied to others).
 * 2. Collect users whose applications pointed at this user's position
 *    (so we can recalculate their application_count afterwards).
 * 3. Delete incoming applications (others applied to the position this user occupies).
 * 4. Set the user as inactive (+ optionally hide from map).
 * 5. Recalculate application_count for all affected users using distinct
 *    (role_id, location_id, department_id) group logic — same as countDistinctGroups().
 *
 * Replaces: Supabase function deactivate_user_and_cleanup()
 * Caller must call invalidateMapCache() after this function returns.
 */
export async function deactivateUserAndCleanup(
    userId: string,
    companyId: string,
    perimeterId: string,
    options: {
        actorId?: string;       // updated_by field
        setShowPositionFalse?: boolean; // default false
    } = {}
): Promise<DeactivateResult> {
    const { actorId, setShowPositionFalse = false } = options;

    const result = await withTx(async (client) => {
        // ── Step 1: delete outgoing applications (this user → others) ────────
        const outgoing = await client.query(
            `DELETE FROM applications
             WHERE user_id     = $1
               AND company_id  = $2
               AND perimeter_id = $3`,
            [userId, companyId, perimeterId]
        );

        // ── Step 2: collect incoming applications BEFORE deletion ────────────
        // We use this snapshot to know which users are impacted and must be
        // recalculated after cleanup.
        const incomingRefsRes = await client.query<{ id: string; user_id: string }>(
            `SELECT a.id, a.user_id
             FROM   applications a
             JOIN   positions    p  ON p.id  = a.position_id
             WHERE  p.occupied_by  = $1
               AND  a.company_id   = $2
               AND  a.perimeter_id = $3`,
            [userId, companyId, perimeterId]
        );
        const cleanupPlan = planDeactivateCleanup(userId, incomingRefsRes.rows);
        const affectedUserIds = cleanupPlan.affectedUserIds;

        // ── Step 3: delete incoming applications (others → this user's position)
        let incomingDeleted = 0;
        if (cleanupPlan.incomingApplicationIds.length > 0) {
            const incoming = await client.query(
                `DELETE FROM applications
                 WHERE company_id = $1
                   AND perimeter_id = $2
                   AND id = ANY($3::uuid[])`,
                [companyId, perimeterId, cleanupPlan.incomingApplicationIds]
            );
            incomingDeleted = incoming.rowCount ?? 0;
        }

        // ── Step 4: set user inactive ─────────────────────────────────────────
        const showPositionClause = setShowPositionFalse
            ? ", show_position = false"
            : "";
        const actorClause = actorId ? `, updated_by = '${actorId}'` : "";

        await client.query(
            `UPDATE users
             SET    availability_status = 'inactive',
                    application_count   = 0
                    ${showPositionClause}
                    ${actorClause}
             WHERE  id            = $1
               AND  company_id   = $2
               AND  coalesce(perimeter_id, home_perimeter_id) = $3`,
            [userId, companyId, perimeterId]
        );

        // ── Step 5: recalculate application_count for affected users ──────────
        // Uses distinct (role_id, location_id, department_id) group logic matching countDistinctGroups().
        let recalculatedCount = 0;
        if (affectedUserIds.length > 0) {
            // Update users who still have applications: recalculate count
            await client.query(
                `UPDATE users u
                 SET    application_count = coalesce(x.cnt, 0)
                 FROM (
                     SELECT a.user_id,
                            count(DISTINCT (uo.role_id, uo.location_id, uo.department_id))::int AS cnt
                     FROM   applications a
                     JOIN   positions    p   ON p.id  = a.position_id
                     JOIN   users        uo  ON uo.id = p.occupied_by
                     WHERE  a.user_id    = ANY($1)
                       AND  a.company_id = $2
                       AND  a.perimeter_id = $3
                       AND  p.occupied_by IS NOT NULL
                     GROUP BY a.user_id
                 ) x
                 WHERE u.id = x.user_id`,
                [affectedUserIds, companyId, perimeterId]
            );

            // Zero out affected users who now have NO applications
            await client.query(
                `UPDATE users
                 SET    application_count = 0
                 WHERE  id = ANY($1)
                   AND  company_id    = $2
                   AND  coalesce(perimeter_id, home_perimeter_id) = $3
                   AND  id NOT IN (
                       SELECT DISTINCT user_id
                       FROM   applications
                       WHERE  company_id   = $2
                         AND  perimeter_id = $3
                   )`,
                [affectedUserIds, companyId, perimeterId]
            );
            recalculatedCount = affectedUserIds.length;
        }

        return {
            deactivatedUserId: userId,
            outgoingDeleted: outgoing.rowCount ?? 0,
            incomingDeleted,
            affectedUsersRecalculated: recalculatedCount,
        };
    });

    invalidateMapCache();
    return result;
}
