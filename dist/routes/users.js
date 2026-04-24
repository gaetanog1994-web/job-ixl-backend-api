import { pool, withTx } from "../db.js";
import { audit } from "../audit.js";
import { invalidateMapCache } from "./map.js";
import { deriveUserState, loadCampaignLifecycle, getCampaignStatus, validateUserReservationAction, } from "../services/campaignLifecycle.js";
// src/routes/users.ts
import express from "express";
export const usersRouter = express.Router();
/**
 * POST /api/users/me/ensure
 * Crea/aggiorna la riga in public.users per l'utente loggato.
 * Serve dopo login per bootstrap profilo applicativo senza supabase.from nel FE.
 */
usersRouter.post("/me/ensure", async (req, res, next) => {
    try {
        const r = req;
        const correlationId = req.correlationId ?? null;
        const access = r.accessContext;
        const { full_name, first_name, last_name, location_id } = req.body ?? {};
        const firstName = String(first_name ?? "").trim();
        const lastName = String(last_name ?? "").trim();
        const fullName = String(full_name ?? `${firstName} ${lastName}`).trim();
        const locationId = location_id ? String(location_id) : null;
        if (!fullName) {
            const e = new Error("missing full_name");
            e.status = 400;
            throw e;
        }
        const { rows } = await pool.query(`
      insert into users (
        id, email, first_name, last_name, full_name, location_id, availability_status,
        is_reserved, application_count, company_id, perimeter_id, home_perimeter_id, updated_by
      )
      values ($1, $2, $3, $4, $5, $6, 'inactive', false, 0, $7, $8, $8, $1)
      on conflict (id) do update
        set first_name = excluded.first_name,
            last_name = excluded.last_name,
            full_name = excluded.full_name,
            location_id = excluded.location_id,
            company_id = coalesce(excluded.company_id, users.company_id),
            perimeter_id = coalesce(excluded.perimeter_id, users.perimeter_id),
            home_perimeter_id = coalesce(excluded.home_perimeter_id, users.home_perimeter_id),
            updated_by = excluded.updated_by
      returning id, email, first_name, last_name, full_name, location_id, availability_status, is_reserved, application_count, role_id, fixed_location, company_id, perimeter_id, home_perimeter_id
      `, [
            r.user.id,
            r.user.email ?? null,
            firstName || null,
            lastName || null,
            fullName,
            locationId,
            access?.currentCompanyId ?? null,
            access?.currentPerimeterId ?? null,
        ]);
        invalidateMapCache();
        await audit("user_ensure_profile", r.user.id, { locationId }, { userId: r.user.id }, correlationId);
        return res.json({ ok: true, user: rows[0], correlationId });
    }
    catch (err) {
        next(err);
    }
});
usersRouter.get("/me", async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const access = req.accessContext;
        if (!userId) {
            const e = new Error("Missing authed user");
            e.status = 401;
            throw e;
        }
        const [{ rows }, campaignStatusRes] = await Promise.all([
            pool.query(`select
             u.id,
             u.email,
             u.first_name,
             u.last_name,
             u.full_name,
             u.availability_status,
             u.is_reserved,
             u.location_id,
             u.role_id,
             u.fixed_location,
             u.company_id,
             u.home_perimeter_id,
             l.name as location_name,
             r.name as role_name,
             u.department_id,
             dpt.name as department_name,
             c.name as company_name,
             p.name as perimeter_name
           from users u
           left join locations l on l.id = u.location_id
           left join roles r on r.id = u.role_id
           left join departments dpt on dpt.id = u.department_id
           left join companies c on c.id = $2
           left join perimeters p on p.id = $3
           where u.id = $1
           limit 1`, [userId, access?.currentCompanyId ?? null, access?.currentPerimeterId ?? null]),
            getCampaignStatus(access?.currentCompanyId ?? "", access?.currentPerimeterId ?? ""),
        ]);
        if (!rows[0]) {
            const e = new Error("User row not found");
            e.status = 404;
            throw e;
        }
        return res.json({
            ok: true,
            user: {
                ...rows[0],
                campaign_status: campaignStatusRes.campaign_status,
                reservations_status: campaignStatusRes.reservations_status,
                user_state: deriveUserState({
                    availabilityStatus: rows[0]?.availability_status ?? null,
                    isReserved: rows[0]?.is_reserved ?? false,
                }),
                access_role: access?.accessRole ?? null,
                is_owner: access?.isOwner ?? false,
                is_super_admin: access?.isCompanySuperAdmin ?? false,
            },
            correlationId: req.correlationId ?? null,
        });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/users/me/applications
usersRouter.get("/me/applications", async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const access = req.accessContext;
        if (!userId) {
            const e = new Error("Missing authed user");
            e.status = 401;
            throw e;
        }
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            const e = new Error("Perimeter context required");
            e.status = 400;
            throw e;
        }
        const lifecycle = await getCampaignStatus(access.currentCompanyId, access.currentPerimeterId);
        if (!lifecycle.campaign_id) {
            return res.json({ ok: true, applications: [], correlationId: req.correlationId ?? null });
        }
        const { rows } = await pool.query(`
      select
        a.id as app_id,
        a.position_id,
        a.priority,
        a.created_at,

        p.id as pos_id,
        p.occupied_by,

        ou.id as occ_user_id,
        ou.full_name as occ_full_name,
        ou.fixed_location as occ_fixed_location,

        r.name as occ_role_name,
        l.name as occ_location_name,
        ou.department_id as target_department_id,
        dpt.name as target_department_name,
        coalesce(
          (
            select json_agg(
              json_build_object('id', rsp.id, 'name', rsp.name)
              order by rsp.name asc
            )
            from user_responsabile_assignments ura
            join responsabili rsp on rsp.id = ura.responsabile_id
            where ura.user_id = ou.id
              and ura.company_id = $2
              and ura.perimeter_id = $3
          ),
          '[]'::json
        ) as target_responsabili,
        coalesce(
          (
            select json_agg(
              json_build_object('id', hr.id, 'name', hr.name)
              order by hr.name asc
            )
            from user_hr_assignments uha
            join hr_managers hr on hr.id = uha.hr_manager_id
            where uha.user_id = ou.id
              and uha.company_id = $2
              and uha.perimeter_id = $3
          ),
          '[]'::json
        ) as target_hr_managers

      from applications a
      join positions p on p.id = a.position_id
      left join users ou on ou.id = p.occupied_by
      left join roles r on r.id = ou.role_id
      left join locations l on l.id = ou.location_id
      left join departments dpt on dpt.id = ou.department_id
      where a.user_id = $1
        and a.company_id = $2
        and a.perimeter_id = $3
        and a.campaign_id = $4
      order by a.priority asc, a.created_at asc
      `, [userId, access.currentCompanyId, access.currentPerimeterId, lifecycle.campaign_id]);
        // ricostruiamo una shape compatibile con la vecchia select supabase (minimo necessario)
        const apps = rows.map((r) => ({
            id: r.app_id,
            position_id: r.position_id,
            priority: r.priority,
            created_at: r.created_at,
            target_department_id: r.target_department_id ?? null,
            target_department_name: r.target_department_name ?? null,
            target_responsabili: Array.isArray(r.target_responsabili) ? r.target_responsabili : [],
            target_hr_managers: Array.isArray(r.target_hr_managers) ? r.target_hr_managers : [],
            positions: {
                id: r.pos_id,
                occupied_by: r.occupied_by,
                users: r.occ_user_id
                    ? {
                        id: r.occ_user_id,
                        full_name: r.occ_full_name,
                        fixed_location: r.occ_fixed_location,
                        department_id: r.target_department_id ?? null,
                        department_name: r.target_department_name ?? null,
                        target_responsabili: Array.isArray(r.target_responsabili) ? r.target_responsabili : [],
                        target_hr_managers: Array.isArray(r.target_hr_managers) ? r.target_hr_managers : [],
                        roles: { name: r.occ_role_name ?? "—" },
                        locations: { name: r.occ_location_name ?? "—" },
                    }
                    : null,
            },
        }));
        return res.json({ ok: true, applications: apps, correlationId: req.correlationId ?? null });
    }
    catch (err) {
        next(err);
    }
});
/**
 * POST /api/users/me/deactivate
 * Legacy endpoint intentionally disabled in RC2 lifecycle.
 */
usersRouter.post("/me/deactivate", async (req, res) => {
    const correlationId = req.correlationId;
    return res.status(409).json({
        ok: false,
        code: "MANUAL_AVAILABILITY_DISABLED",
        error: "Use reservation window actions; manual availability changes are disabled",
        correlationId,
    });
});
/**
 * POST /api/users/me/reservation
 * Reserve current user for next campaign (allowed only in reservation window).
 */
usersRouter.post("/me/reservation", async (req, res) => {
    const r = req;
    const correlationId = req.correlationId;
    const companyId = r.accessContext?.currentCompanyId ?? null;
    const perimeterId = r.accessContext?.currentPerimeterId ?? null;
    if (!companyId || !perimeterId) {
        return res.status(400).json({ error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
    }
    try {
        const out = await withTx(async (client) => {
            const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId, { forUpdate: true });
            const userRes = await client.query(`
                select is_reserved, availability_status
                from users
                where id = $1
                  and company_id = $2
                  and coalesce(perimeter_id, home_perimeter_id) = $3
                limit 1
                `, [r.user.id, companyId, perimeterId]);
            if (!userRes.rows.length) {
                return { missingUser: true };
            }
            const invalid = validateUserReservationAction({
                lifecycle,
                action: "reserve",
                isReserved: Boolean(userRes.rows[0].is_reserved),
            });
            if (invalid)
                return { invalid };
            const updated = await client.query(`
                update users
                set is_reserved = true,
                    availability_status = 'inactive',
                    show_position = false
                where id = $1
                  and company_id = $2
                  and coalesce(perimeter_id, home_perimeter_id) = $3
                returning availability_status, is_reserved
                `, [r.user.id, companyId, perimeterId]);
            return {
                user_state: deriveUserState({
                    availabilityStatus: updated.rows[0]?.availability_status ?? "inactive",
                    isReserved: updated.rows[0]?.is_reserved ?? true,
                }),
                campaign_status: lifecycle.campaignStatus,
                reservations_status: lifecycle.reservationsStatus,
            };
        });
        if ("missingUser" in out) {
            return res.status(404).json({ ok: false, error: "USER_NOT_FOUND", correlationId });
        }
        if ("invalid" in out && out.invalid) {
            const invalid = out.invalid;
            return res.status(invalid.status).json({ ok: false, code: invalid.code, error: invalid.message, correlationId });
        }
        invalidateMapCache();
        await audit("user_reserve_for_campaign", r.user.id, {}, out, correlationId);
        return res.status(200).json({ ok: true, ...out, correlationId });
    }
    catch (e) {
        await audit("user_reserve_for_campaign", r.user.id, {}, { error: String(e?.message ?? e) }, correlationId);
        return res.status(500).json({ error: "RESERVE_FAILED", correlationId });
    }
});
/**
 * DELETE /api/users/me/reservation
 * Unreserve current user (allowed only in reservation window).
 */
usersRouter.delete("/me/reservation", async (req, res) => {
    const r = req;
    const correlationId = req.correlationId;
    const companyId = r.accessContext?.currentCompanyId ?? null;
    const perimeterId = r.accessContext?.currentPerimeterId ?? null;
    if (!companyId || !perimeterId) {
        return res.status(400).json({ error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
    }
    try {
        const out = await withTx(async (client) => {
            const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId, { forUpdate: true });
            const userRes = await client.query(`
                select is_reserved, availability_status
                from users
                where id = $1
                  and company_id = $2
                  and coalesce(perimeter_id, home_perimeter_id) = $3
                limit 1
                `, [r.user.id, companyId, perimeterId]);
            if (!userRes.rows.length) {
                return { missingUser: true };
            }
            const invalid = validateUserReservationAction({
                lifecycle,
                action: "unreserve",
                isReserved: Boolean(userRes.rows[0].is_reserved),
            });
            if (invalid)
                return { invalid };
            const updated = await client.query(`
                update users
                set is_reserved = false,
                    availability_status = 'inactive',
                    show_position = false
                where id = $1
                  and company_id = $2
                  and coalesce(perimeter_id, home_perimeter_id) = $3
                returning availability_status, is_reserved
                `, [r.user.id, companyId, perimeterId]);
            return {
                user_state: deriveUserState({
                    availabilityStatus: updated.rows[0]?.availability_status ?? "inactive",
                    isReserved: updated.rows[0]?.is_reserved ?? false,
                }),
                campaign_status: lifecycle.campaignStatus,
                reservations_status: lifecycle.reservationsStatus,
            };
        });
        if ("missingUser" in out) {
            return res.status(404).json({ ok: false, error: "USER_NOT_FOUND", correlationId });
        }
        if ("invalid" in out && out.invalid) {
            const invalid = out.invalid;
            return res.status(invalid.status).json({ ok: false, code: invalid.code, error: invalid.message, correlationId });
        }
        invalidateMapCache();
        await audit("user_unreserve_for_campaign", r.user.id, {}, out, correlationId);
        return res.status(200).json({ ok: true, ...out, correlationId });
    }
    catch (e) {
        await audit("user_unreserve_for_campaign", r.user.id, {}, { error: String(e?.message ?? e) }, correlationId);
        return res.status(500).json({ error: "UNRESERVE_FAILED", correlationId });
    }
});
/**
 * POST /api/users/:userId/reorder-applications
 * Reorder application priorities for a user.
 * Replaces Supabase RPC reorder_user_applications() — now fully in-backend.
 *
 * Body: { updates: [{ app_ids: string[], priority: number }] }
 * Each entry sets the same priority on all listed application IDs.
 *
 * Validation:
 * - User can only reorder their own applications (unless admin).
 * - priority must be 1..max_applications from app_config.
 * - All app_ids must belong to the requesting user + current tenant.
 */
usersRouter.post("/:userId/reorder-applications", async (req, res, next) => {
    const r = req;
    const correlationId = req.correlationId;
    const tokenUserId = r.user.id;
    const targetUserId = req.params.userId;
    const access = r.accessContext;
    // Only the user themselves (or admin) can reorder
    if (targetUserId !== tokenUserId && !access?.canManagePerimeter) {
        return res.status(403).json({ error: "FORBIDDEN", message: "Cannot reorder applications for another user", correlationId });
    }
    if (!access?.currentCompanyId || !access?.currentPerimeterId) {
        return res.status(400).json({ error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
    }
    const updates = req.body?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: "INVALID_BODY", message: "updates must be a non-empty array", correlationId });
    }
    // Validate each update entry
    for (const u of updates) {
        if (!Array.isArray(u.app_ids) || u.app_ids.length === 0 || typeof u.priority !== "number") {
            return res.status(400).json({
                error: "INVALID_BODY",
                message: "Each update must have app_ids (string[]) and priority (number)",
                correlationId,
            });
        }
        if (!Number.isFinite(u.priority) || u.priority < 1) {
            return res.status(400).json({
                error: "INVALID_PRIORITY",
                message: "priority must be >= 1",
                correlationId,
            });
        }
    }
    try {
        // Fetch max_applications for upper bound validation
        const { rows: configRows } = await pool.query(`SELECT max_applications FROM app_config
             WHERE singleton = true AND company_id = $1 AND perimeter_id = $2 LIMIT 1`, [access.currentCompanyId, access.currentPerimeterId]);
        const maxApplications = Number(configRows[0]?.max_applications ?? 0);
        for (const u of updates) {
            if (maxApplications > 0 && u.priority > maxApplications) {
                return res.status(400).json({
                    error: "INVALID_PRIORITY",
                    message: `priority ${u.priority} exceeds max_applications (${maxApplications})`,
                    correlationId,
                });
            }
        }
        // Apply all updates in a transaction, scoped to user + tenant
        await withTx(async (client) => {
            for (const u of updates) {
                await client.query(`UPDATE applications
                     SET    priority = $1
                     WHERE  id         = ANY($2::uuid[])
                       AND  user_id    = $3
                       AND  company_id = $4
                       AND  perimeter_id = $5`, [u.priority, u.app_ids, targetUserId, access.currentCompanyId, access.currentPerimeterId]);
            }
        });
        invalidateMapCache();
        await audit("applications_reorder", r.user.id, { targetUserId, updatesCount: updates.length }, {}, correlationId);
        return res.status(200).json({ ok: true, correlationId });
    }
    catch (e) {
        return next(e);
    }
});
/**
 * POST /api/users/me/activate
 * Legacy endpoint intentionally disabled in RC2 lifecycle.
 */
usersRouter.post("/me/activate", async (req, res) => {
    const correlationId = req.correlationId;
    return res.status(409).json({
        ok: false,
        code: "MANUAL_AVAILABILITY_DISABLED",
        error: "Use reservation window actions; manual availability changes are disabled",
        correlationId,
    });
});
//# sourceMappingURL=users.js.map