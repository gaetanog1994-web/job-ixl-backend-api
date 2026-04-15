import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth.js";
import { supabaseAdmin, pool } from "../db.js";
import { invalidateMapCache } from "./map.js";
import { audit } from "../audit.js";
import { countDistinctGroups } from "../services/countDistinctGroups.js";
export const applicationsRouter = Router();
async function countDistinctGroupsInPerimeter(userId, companyId, perimeterId) {
    const { data: apps, error: appsErr } = await supabaseAdmin
        .from("applications")
        .select("position_id")
        .eq("user_id", userId)
        .eq("company_id", companyId)
        .eq("perimeter_id", perimeterId);
    if (appsErr)
        throw appsErr;
    const positionIds = (apps ?? []).map((r) => r.position_id).filter(Boolean);
    if (positionIds.length === 0)
        return 0;
    const { data: positions, error: posErr } = await supabaseAdmin
        .from("positions")
        .select("id, occupied_by")
        .in("id", positionIds)
        .eq("company_id", companyId)
        .eq("perimeter_id", perimeterId);
    if (posErr)
        throw posErr;
    const occupantIds = (positions ?? []).map((p) => p.occupied_by).filter(Boolean);
    if (occupantIds.length === 0)
        return 0;
    const { data: users, error: usersErr } = await supabaseAdmin
        .from("users")
        .select("id, role_id, location_id")
        .in("id", occupantIds)
        .eq("company_id", companyId);
    if (usersErr)
        throw usersErr;
    return countDistinctGroups({
        positionIds,
        positions: (positions ?? []),
        occupants: (users ?? []),
    });
}
/**
 * POST /api/users/:userId/applications/bulk
 * Body: { positionIds: string[], priority: number }
 *
 * RBAC:
 * - se :userId != token user => requireAdmin
 *
 * Regole:
 * - priority deve essere 1..max_applications (da app_config)
 * - positionIds dedup / non vuoto
 * - idempotenza "soft": se esistono già, non deve esplodere l'intero batch
 */
applicationsRouter.post("/users/:userId/applications/bulk", requireAuth, async (req, res) => {
    const r = req;
    const correlationId = req.correlationId;
    const tokenUserId = r.user.id;
    const targetUserId = req.params.userId || tokenUserId;
    // 🔐 Admin enforcement se opero per un altro user
    if (targetUserId !== tokenUserId) {
        await new Promise((resolve, reject) => {
            requireAdmin(r, res, (err) => (err ? reject(err) : resolve()));
        });
    }
    try {
        const access = r.accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({ error: "PERIMETER_CONTEXT_REQUIRED", message: "perimeter context required" });
        }
        const positionIdsRaw = req.body?.positionIds;
        const priorityRaw = req.body?.priority;
        const positionIds = Array.from(new Set(Array.isArray(positionIdsRaw)
            ? positionIdsRaw.map((x) => String(x)).filter(Boolean)
            : []));
        const priority = Number(priorityRaw);
        if (!positionIds.length) {
            return res.status(400).json({ error: "INVALID_BODY", message: "positionIds must be a non-empty array" });
        }
        if (!Number.isFinite(priority)) {
            return res.status(400).json({ error: "INVALID_BODY", message: "priority must be a number" });
        }
        // campaign_status check: reject new applications when campaign is closed
        const { rows: perimeterRows } = await pool.query(`select campaign_status from perimeters where id = $1 limit 1`, [access.currentPerimeterId]);
        if (perimeterRows[0]?.campaign_status !== "open") {
            return res.status(403).json({
                error: "CAMPAIGN_CLOSED",
                message: "La campagna di mobilità non è aperta",
            });
        }
        // max_applications da config
        const { data: config, error: configErr } = await supabaseAdmin
            .from("app_config")
            .select("max_applications")
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId)
            .single();
        if (configErr)
            throw configErr;
        const maxApplications = Number(config?.max_applications ?? 0);
        if (!maxApplications || maxApplications < 1) {
            return res.status(500).json({ error: "CONFIG_INVALID", message: "max_applications missing/invalid" });
        }
        if (priority < 1 || priority > maxApplications) {
            return res.status(400).json({
                error: "INVALID_PRIORITY",
                message: `priority must be between 1 and ${maxApplications}`,
            });
        }
        // Regola prodotto: una priority non può essere usata più di una volta dallo stesso utente,
        // a meno che le righe esistenti appartengano allo stesso gruppo (role_id, location_id)
        // delle positionIds in arrivo (stessa candidatura logica, nuovi occupanti).
        // role_id e location_id risiedono su users (tramite occupied_by su positions).
        // Incoming: resolve role+location via occupant
        const { data: incomingPos, error: inPosErr } = await supabaseAdmin
            .from("positions")
            .select("id, occupied_by")
            .in("id", positionIds)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (inPosErr)
            throw inPosErr;
        const incomingOccupantIds = (incomingPos ?? []).map((p) => p.occupied_by).filter(Boolean);
        const { data: incomingUsers, error: inUsersErr } = await supabaseAdmin
            .from("users")
            .select("id, role_id, location_id")
            .in("id", incomingOccupantIds)
            .eq("company_id", access.currentCompanyId);
        if (inUsersErr)
            throw inUsersErr;
        const incomingGroups = new Set((incomingUsers ?? []).map((u) => `${u.role_id}__${u.location_id}`));
        // Existing: what positions already use this priority?
        const { data: used, error: usedErr } = await supabaseAdmin
            .from("applications")
            .select("position_id")
            .eq("user_id", targetUserId)
            .eq("priority", priority)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (usedErr)
            throw usedErr;
        const usedPositionIds = (used ?? []).map((r) => r.position_id).filter(Boolean);
        let existingConflict = false;
        if (usedPositionIds.length > 0) {
            const { data: usedPos, error: upErr } = await supabaseAdmin
                .from("positions")
                .select("id, occupied_by")
                .in("id", usedPositionIds)
                .eq("company_id", access.currentCompanyId)
                .eq("perimeter_id", access.currentPerimeterId);
            if (upErr)
                throw upErr;
            const usedOccupantIds = (usedPos ?? []).map((p) => p.occupied_by).filter(Boolean);
            const { data: usedUsers, error: uuErr } = await supabaseAdmin
                .from("users")
                .select("id, role_id, location_id")
                .in("id", usedOccupantIds)
                .eq("company_id", access.currentCompanyId);
            if (uuErr)
                throw uuErr;
            existingConflict = (usedUsers ?? []).some((u) => !incomingGroups.has(`${u.role_id}__${u.location_id}`));
        }
        if (existingConflict) {
            return res.status(400).json({
                error: "PRIORITY_ALREADY_USED",
                message: `priority ${priority} is already used by this user`,
            });
        }
        // Insert batch
        const rows = positionIds.map((position_id) => ({
            user_id: targetUserId,
            position_id,
            priority,
            company_id: access.currentCompanyId,
            perimeter_id: access.currentPerimeterId,
        }));
        const { error: insErr } = await supabaseAdmin
            .from("applications")
            .upsert(rows, { onConflict: "user_id,position_id", ignoreDuplicates: true });
        if (insErr) {
            // idempotenza "soft": se ci sono duplicati e hai un vincolo unique, qui potrebbe esplodere.
            // Per ora: ritorniamo errore esplicito. (Se mi confermi unique(user_id, position_id),
            // nel prossimo step lo gestiamo con upsert/onConflict.)
            return res.status(409).json({ error: "INSERT_FAILED", message: insErr.message });
        }
        invalidateMapCache(); // ✅ ESATTAMENTE QUI
        const distinctCount = await countDistinctGroupsInPerimeter(targetUserId, access.currentCompanyId, access.currentPerimeterId);
        await supabaseAdmin
            .from("users")
            .update({ application_count: distinctCount })
            .eq("id", targetUserId)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        await audit("applications_bulk_apply", r.user.id, { targetUserId, priority, positionIdsCount: positionIds.length }, { inserted: rows.length, application_count: distinctCount }, correlationId);
        return res.status(200).json({ ok: true, inserted: rows.length });
    }
    catch (err) {
        console.error("❌ applications bulk insert error", err);
        return res.status(500).json({ error: "APPLICATIONS_BULK_INSERT_FAILED" });
    }
});
/**
 * DELETE /api/users/:userId/applications/bulk
 * Body: { positionIds: string[] }
 */
applicationsRouter.delete("/users/:userId/applications/bulk", requireAuth, async (req, res) => {
    const r = req;
    const correlationId = req.correlationId;
    const tokenUserId = r.user.id;
    const targetUserId = req.params.userId || tokenUserId;
    // 🔐 Admin enforcement se opero per un altro user
    if (targetUserId !== tokenUserId) {
        await new Promise((resolve, reject) => {
            requireAdmin(r, res, (e) => (e ? reject(e) : resolve()));
        });
    }
    try {
        const access = r.accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({ error: "PERIMETER_CONTEXT_REQUIRED", message: "perimeter context required" });
        }
        const positionIdsRaw = req.body?.positionIds;
        const positionIds = Array.from(new Set(Array.isArray(positionIdsRaw)
            ? positionIdsRaw.map((x) => String(x)).filter(Boolean)
            : []));
        if (!positionIds.length) {
            return res.status(400).json({ error: "INVALID_BODY", message: "positionIds must be a non-empty array" });
        }
        const { error: delErr } = await supabaseAdmin
            .from("applications")
            .delete()
            .eq("user_id", targetUserId)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId)
            .in("position_id", positionIds);
        if (delErr)
            throw delErr;
        invalidateMapCache();
        // riallinea application_count contando gruppi (role_id, location_id) distinti
        const distinctCount = await countDistinctGroupsInPerimeter(targetUserId, access.currentCompanyId, access.currentPerimeterId);
        await supabaseAdmin
            .from("users")
            .update({ application_count: distinctCount })
            .eq("id", targetUserId)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        await audit("applications_bulk_withdraw", r.user.id, { targetUserId, positionIdsCount: positionIds.length }, { application_count: distinctCount }, correlationId);
        return res.status(200).json({ ok: true, deleted: true, application_count: distinctCount });
    }
    catch (err) {
        console.error("❌ applications bulk delete error", err);
        await audit("applications_bulk_withdraw", r.user.id, { targetUserId }, { error: String(err?.message ?? err) }, correlationId);
        return res.status(500).json({ error: "APPLICATIONS_BULK_DELETE_FAILED" });
    }
});
//# sourceMappingURL=applications.js.map