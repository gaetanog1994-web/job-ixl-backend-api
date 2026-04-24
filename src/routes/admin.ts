import { Router, Request, Response } from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import { Readable } from "stream";
import { withTx, pool, supabaseAdmin } from "../db.js";
import type { AuthedRequest } from "../auth.js";
import { audit } from "../audit.js";
import { invalidateMapCache } from "./map.js";
import { deactivateUserAndCleanup } from "../services/users.js";
import { rebalanceApplications, type RebalanceApplicationRow } from "../services/rebalanceApplications.js";
import { requireOperationalPerimeterAdmin } from "../tenant.js";
import { normalizeEmailInput, resolveAuthUserByEmail } from "../services/authUsers.js";
import {
    deriveUserState,
    loadCampaignLifecycle,
    getCampaignStatus,
    openReservations,
    closeReservations,
    openCampaign,
    closeCampaign,
} from "../services/campaignLifecycle.js";

export const adminRouter = Router();
const uploadExcel = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL!;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN!;
const appEnv = (process.env.APP_ENV ?? (process.env.NODE_ENV === "production" ? "production" : "development"))
    .toLowerCase();
const isProduction = appEnv === "production";
const isDevelopment = appEnv === "development";
const ENABLE_HARNESS_ENDPOINTS =
    !isProduction &&
    (
        process.env.ENABLE_HARNESS_ENDPOINTS === "true" ||
        (isDevelopment && process.env.ENABLE_HARNESS_ENDPOINTS !== "false")
    );

/**
 * Guard for harness-only endpoints (reset_*, initialize_test_scenario).
 * These must not be callable in production — they destroy live data.
 * §3.5 P1: confine harness functions to dev/staging.
 */
function harnessOnly(req: Request, res: Response): boolean {
    if (!ENABLE_HARNESS_ENDPOINTS) {
        res.status(403).json({
            ok: false,
            error: "HARNESS_DISABLED",
            message:
                "Harness endpoints are disabled for this environment. Set ENABLE_HARNESS_ENDPOINTS=true only in controlled dev/staging.",
        });
        return true; // caller should return immediately
    }
    return false;
}

/**
 * Rebalance applications after max_applications decreases.
 * Extracted from inline logic in POST /api/admin/config/max-applications.
 * §3.5 P1: replaces DB trigger trg_rebalance_applications_on_max_change.
 *
 * Steps (in caller-provided transaction client):
 * 1. Delete applications ranked > newMax per user (keep top-priority ones).
 * 2. Compact remaining priorities to be sequential (1..N).
 * 3. Recalculate application_count for ALL users in the perimeter.
 */
export async function rebalanceApplicationsAfterMaxChange(
    client: import("pg").PoolClient,
    newMax: number,
    companyId: string,
    perimeterId: string
): Promise<{ deleted: number; prioritiesUpdated: number }> {
    const applicationsRes = await client.query<RebalanceApplicationRow>(
        `SELECT id, user_id, priority, created_at
         FROM applications
         WHERE company_id = $1
           AND perimeter_id = $2`,
        [companyId, perimeterId]
    );

    const plan = rebalanceApplications(applicationsRes.rows, newMax);

    let deleted = 0;
    if (plan.deletedIds.length > 0) {
        const delRes = await client.query(
            `DELETE FROM applications
             WHERE company_id = $1
               AND perimeter_id = $2
               AND id = ANY($3::uuid[])`,
            [companyId, perimeterId, plan.deletedIds]
        );
        deleted = delRes.rowCount ?? 0;
    }

    let prioritiesUpdated = 0;
    if (plan.updates.length > 0) {
        const ids = plan.updates.map((u) => u.id);
        const priorities = plan.updates.map((u) => u.priority);

        const updRes = await client.query(
            `WITH data AS (
                SELECT *
                FROM unnest($1::uuid[], $2::int[]) AS t(id, priority)
            )
            UPDATE applications a
            SET priority = d.priority
            FROM data d
            WHERE a.id = d.id
              AND a.company_id = $3
              AND a.perimeter_id = $4
              AND a.priority IS DISTINCT FROM d.priority`,
            [ids, priorities, companyId, perimeterId]
        );
        prioritiesUpdated = updRes.rowCount ?? 0;
    }

    // Recalculate application_count for users who still have applications
    await client.query(
        `UPDATE users u
         SET    application_count = coalesce(x.cnt, 0)
         FROM (
             SELECT a.user_id,
                    count(DISTINCT (uo.role_id, uo.location_id))::int AS cnt
             FROM   applications a
             JOIN   positions    p   ON p.id  = a.position_id
             JOIN   users        uo  ON uo.id = p.occupied_by
             WHERE  a.company_id   = $1
               AND  a.perimeter_id = $2
               AND  p.occupied_by  IS NOT NULL
             GROUP BY a.user_id
         ) x
         WHERE u.id = x.user_id
           AND u.company_id = $1
           AND coalesce(u.perimeter_id, u.home_perimeter_id) = $2`,
        [companyId, perimeterId]
    );

    // Zero out users who now have no applications
    await client.query(
        `UPDATE users
         SET    application_count = 0
         WHERE  company_id    = $1
           AND  coalesce(perimeter_id, home_perimeter_id) = $2
           AND  id NOT IN (
               SELECT DISTINCT user_id
               FROM   applications
               WHERE  company_id   = $1
                 AND  perimeter_id = $2
           )`,
        [companyId, perimeterId]
    );

    return {
        deleted,
        prioritiesUpdated,
    };
}

if (!GRAPH_SERVICE_URL) throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN) throw new Error("Missing GRAPH_SERVICE_TOKEN");

function getTenantScope(req: Request) {
    const access = (req as AuthedRequest).accessContext;
    return {
        access,
        companyId: access?.currentCompanyId ?? null,
        perimeterId: access?.currentPerimeterId ?? null,
    };
}

function normalizeImportCellValue(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value).trim();
    if (typeof value === "boolean") return value ? "Sì" : "No";
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object" && "text" in (value as Record<string, unknown>)) {
        return String((value as Record<string, unknown>).text ?? "").trim();
    }
    return "";
}

function isValidEmailFormat(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseFixedLocation(value: string): boolean | null {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === "sì" || normalized === "si") return true;
    if (normalized === "no") return false;
    return null;
}

type BulkImportErrorItem = {
    row: number;
    email: string;
    error: string;
};

async function resolveOrInviteAuthUserId(params: {
    email: string;
    firstName: string;
    lastName: string;
    fullName: string;
}): Promise<string> {
    const { email, firstName, lastName, fullName } = params;
    const authAdmin = (supabaseAdmin.auth.admin as any);

    const inviteResult = await authAdmin.inviteUserByEmail(email, {
        data: {
            first_name: firstName || null,
            last_name: lastName || null,
            full_name: fullName,
        },
    });

    const inviteError = inviteResult?.error ?? null;
    const invitedUserId = inviteResult?.data?.user?.id ?? null;
    if (!inviteError && invitedUserId) return invitedUserId;

    if (typeof authAdmin.getUserByEmail === "function") {
        const userByEmail = await authAdmin.getUserByEmail(email);
        const existingByEmailId = userByEmail?.data?.user?.id ?? null;
        if (existingByEmailId) return existingByEmailId;
    }

    const existingUser = await resolveAuthUserByEmail(authAdmin, email);
    if (existingUser?.id) return existingUser.id;

    if (inviteError?.message) {
        throw new Error(inviteError.message);
    }
    throw new Error("Impossibile invitare o risolvere utente auth");
}

async function getTableColumns(
    client: import("pg").PoolClient,
    tableName: string
): Promise<Set<string>> {
    const { rows } = await client.query<{ column_name: string }>(
        `
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
        `,
        [tableName]
    );
    return new Set(rows.map((r) => r.column_name));
}

async function deleteScopedAuditRows(
    client: import("pg").PoolClient,
    tableName: "audit_log" | "admin_audit_log",
    companyId: string,
    perimeterId: string
): Promise<{ deleted: number; strategy: "scope_columns" | "payload_json" | "unsupported" | "table_missing" }> {
    const columns = await getTableColumns(client, tableName);
    if (columns.size === 0) {
        return { deleted: 0, strategy: "table_missing" };
    }

    if (columns.has("company_id") && columns.has("perimeter_id")) {
        const out = await client.query(
            `delete from ${tableName}
             where company_id = $1
               and perimeter_id = $2`,
            [companyId, perimeterId]
        );
        return { deleted: out.rowCount ?? 0, strategy: "scope_columns" };
    }

    if (columns.has("payload_json")) {
        const out = await client.query(
            `delete from ${tableName}
             where (
                (payload_json->>'company_id' = $1 or payload_json->>'companyId' = $1)
                and
                (payload_json->>'perimeter_id' = $2 or payload_json->>'perimeterId' = $2)
             )`,
            [companyId, perimeterId]
        );
        return { deleted: out.rowCount ?? 0, strategy: "payload_json" };
    }

    return { deleted: 0, strategy: "unsupported" };
}

async function deleteUserSkillsRows(
    client: import("pg").PoolClient,
    userId: string,
    companyId: string,
    perimeterId: string
): Promise<{ deleted: number; strategy: "scoped" | "user_only" | "unsupported" | "table_missing" }> {
    const columns = await getTableColumns(client, "user_skills");
    if (columns.size === 0) return { deleted: 0, strategy: "table_missing" };
    if (!columns.has("user_id")) return { deleted: 0, strategy: "unsupported" };

    if (columns.has("company_id") && columns.has("perimeter_id")) {
        const out = await client.query(
            `delete from user_skills
             where user_id = $1
               and company_id = $2
               and perimeter_id = $3`,
            [userId, companyId, perimeterId]
        );
        return { deleted: out.rowCount ?? 0, strategy: "scoped" };
    }

    const out = await client.query(
        `delete from user_skills
         where user_id = $1`,
        [userId]
    );
    return { deleted: out.rowCount ?? 0, strategy: "user_only" };
}

/**
 * DELETE /api/admin/gdpr/tenant
 * Requires:
 * - global admin auth (mounted in /api/admin stack)
 * - operational perimeter admin membership (route-level)
 *
 * Deletes tenant-scoped data for current company/perimeter:
 * - applications
 * - interlocking_scenarios
 * - audit_log/admin_audit_log (when scope can be resolved)
 * - sets all perimeter users to availability_status='inactive'
 *
 * Does NOT delete auth.users identities (manual Supabase admin operation).
 */
adminRouter.delete("/gdpr/tenant", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    const { companyId, perimeterId } = getTenantScope(req);

    if (!companyId || !perimeterId) {
        return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
    }

    // Explicit pre-audit requested by sprint: log intent before destructive execution.
    await audit(
        "gdpr_tenant_delete_requested",
        r.user.id,
        {
            companyId,
            perimeterId,
            note: "Deletes applications, interlocking_scenarios, tenant-scoped audit rows, and deactivates users. Does not delete auth.users.",
        },
        { started: true },
        correlationId
    );

    try {
        const out = await withTx(async (client) => {
            const applicationsDelete = await client.query(
                `delete from applications
                 where company_id = $1
                   and perimeter_id = $2`,
                [companyId, perimeterId]
            );

            const scenariosDelete = await client.query(
                `delete from interlocking_scenarios
                 where company_id = $1
                   and perimeter_id = $2`,
                [companyId, perimeterId]
            );

            const auditDelete = await deleteScopedAuditRows(client, "audit_log", companyId, perimeterId);
            const adminAuditDelete = await deleteScopedAuditRows(client, "admin_audit_log", companyId, perimeterId);

            const usersDeactivate = await client.query(
                `update users
                 set availability_status = 'inactive',
                     application_count = 0
                 where company_id = $1
                   and coalesce(perimeter_id, home_perimeter_id) = $2`,
                [companyId, perimeterId]
            );

            return {
                companyId,
                perimeterId,
                deleted: {
                    applications: applicationsDelete.rowCount ?? 0,
                    interlocking_scenarios: scenariosDelete.rowCount ?? 0,
                    audit_log: auditDelete,
                    admin_audit_log: adminAuditDelete,
                },
                usersUpdated: {
                    setInactive: usersDeactivate.rowCount ?? 0,
                },
            };
        });

        invalidateMapCache();

        await audit(
            "gdpr_tenant_delete_completed",
            r.user.id,
            { correlationId },
            out,
            correlationId
        );

        return res.status(200).json({
            ok: true,
            out,
            gdprScope: {
                deleted: [
                    "applications (current perimeter)",
                    "interlocking_scenarios (current perimeter)",
                    "audit_log/admin_audit_log rows resolvable to current perimeter",
                ],
                notDeleted: [
                    "supabase auth.users identities (must be removed manually via Supabase admin/dashboard)",
                ],
            },
            correlationId,
        });
    } catch (e: any) {
        await audit(
            "gdpr_tenant_delete_failed",
            r.user.id,
            { companyId, perimeterId },
            { error: String(e?.message ?? e) },
            correlationId
        );
        return res.status(500).json({
            ok: false,
            error: "GDPR tenant delete failed",
            detail: String(e?.message ?? e),
            correlationId,
        });
    }
});

/**
 * GET /api/admin/gdpr/tenant/export
 * Requires global admin auth (stack-level).
 * Returns tenant-scoped JSON export as downloadable attachment.
 */
adminRouter.get("/gdpr/tenant/export", async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    const { companyId, perimeterId } = getTenantScope(req);

    if (!companyId || !perimeterId) {
        return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
    }

    try {
        const [usersRes, appsRes, scenariosRes] = await Promise.all([
            pool.query(
                `select *
                 from users
                 where company_id = $1
                   and coalesce(perimeter_id, home_perimeter_id) = $2
                 order by created_at asc nulls last, id`,
                [companyId, perimeterId]
            ),
            pool.query(
                `select *
                 from applications
                 where company_id = $1
                   and perimeter_id = $2
                 order by created_at asc nulls last, id`,
                [companyId, perimeterId]
            ),
            pool.query(
                `select *
                 from interlocking_scenarios
                 where company_id = $1
                   and perimeter_id = $2
                 order by generated_at desc nulls last, created_at desc nulls last, id`,
                [companyId, perimeterId]
            ),
        ]);

        const today = new Date().toISOString().slice(0, 10);
        const filename = `jip-export-${perimeterId}-${today}.json`;
        const payload = {
            exportedAt: new Date().toISOString(),
            companyId,
            perimeterId,
            users: usersRes.rows,
            applications: appsRes.rows,
            interlocking_scenarios: scenariosRes.rows,
        };

        await audit(
            "gdpr_tenant_export",
            r.user.id,
            { companyId, perimeterId },
            {
                users: usersRes.rowCount ?? usersRes.rows.length,
                applications: appsRes.rowCount ?? appsRes.rows.length,
                scenarios: scenariosRes.rowCount ?? scenariosRes.rows.length,
            },
            correlationId
        );

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.status(200).send(JSON.stringify(payload, null, 2));
    } catch (e: any) {
        await audit(
            "gdpr_tenant_export_failed",
            r.user.id,
            { companyId, perimeterId },
            { error: String(e?.message ?? e) },
            correlationId
        );
        return res.status(500).json({
            ok: false,
            error: "GDPR tenant export failed",
            detail: String(e?.message ?? e),
            correlationId,
        });
    }
});

/**
 * DELETE /api/admin/gdpr/users/:userId
 * Requires global admin auth (stack-level).
 * Deactivates and anonymizes the user while preserving row/FK integrity.
 */
adminRouter.delete("/gdpr/users/:userId", async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    const { companyId, perimeterId } = getTenantScope(req);
    const userId = String(req.params.userId ?? "").trim();

    if (!companyId || !perimeterId) {
        return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
    }
    if (!userId) {
        return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED", correlationId });
    }

    try {
        const cleanupOut = await deactivateUserAndCleanup(userId, companyId, perimeterId, {
            actorId: r.user.id,
            setShowPositionFalse: true,
        });

        const out = await withTx(async (client) => {
            const userSkillsDelete = await deleteUserSkillsRows(client, userId, companyId, perimeterId);

            const userUpdate = await client.query(
                `update users
                 set availability_status = 'inactive',
                     show_position = false,
                     full_name = 'Utente rimosso',
                     email = 'removed@removed.invalid',
                     application_count = 0,
                     updated_by = $4
                 where id = $1
                   and company_id = $2
                   and coalesce(perimeter_id, home_perimeter_id) = $3`,
                [userId, companyId, perimeterId, r.user.id]
            );

            if ((userUpdate.rowCount ?? 0) === 0) {
                throw new Error("USER_NOT_FOUND_IN_SCOPE");
            }

            return {
                cleanup: cleanupOut,
                user_skills: userSkillsDelete,
                usersAnonymized: userUpdate.rowCount ?? 0,
            };
        });

        invalidateMapCache();

        await audit(
            "gdpr_user_delete_anonymize",
            r.user.id,
            { userId, companyId, perimeterId },
            out,
            correlationId
        );

        return res.status(200).json({
            ok: true,
            out,
            note: "User row preserved for FK integrity. auth.users identity is not deleted by this endpoint.",
            correlationId,
        });
    } catch (e: any) {
        const message = String(e?.message ?? e);
        const status = message === "USER_NOT_FOUND_IN_SCOPE" ? 404 : 500;

        await audit(
            "gdpr_user_delete_anonymize_failed",
            r.user.id,
            { userId, companyId, perimeterId },
            { error: message },
            correlationId
        );

        return res.status(status).json({
            ok: false,
            error: status === 404 ? "USER_NOT_FOUND_IN_SCOPE" : "GDPR_USER_DELETE_FAILED",
            detail: message,
            correlationId,
        });
    }
});

// Harness guard + operational admin gate for test-scenarios namespace.
// GET routes: skip both harness guard and requireOperationalPerimeterAdmin.
//   requireAdmin at adminApi level already enforces canManagePerimeter.
//   Owners/super-admins without direct perimeter_memberships pass requireAdmin but
//   would fail requireOperationalPerimeterAdmin → silent 403 → 0 results in UI.
// POST /:id/initialize: operational flow (not harness-only), requires operational admin.
// All other mutating routes: harness-only in prod, also require operational admin.
adminRouter.use("/test-scenarios", (req, res, next) => {
    if (req.method === "GET") return next();
    // Scenario initialization is now an operational flow (not a dev-only harness action).
    if (req.method === "POST" && /^\/[^/]+\/initialize\/?$/.test(req.path)) {
        return requireOperationalPerimeterAdmin(req, res, next);
    }
    if (harnessOnly(req, res)) return;
    requireOperationalPerimeterAdmin(req, res, next);
});

/**
 * POST /api/admin/test-scenarios/:id/initialize
 * Additive: sets scenario users to available and inserts scenario applications
 * on top of the current state. Does NOT reset or delete existing users/applications.
 * Requires campaign_status='open'.
 */
adminRouter.post(
    "/test-scenarios/:id/initialize",
    async (req: Request, res: Response) => {
        const r = req as unknown as AuthedRequest;
        const scenarioId = req.params.id;
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }

        try {
            const result = await withTx(async (client) => {
                const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId, { forUpdate: true });
                if (lifecycle.campaignStatus !== "open") {
                    return {
                        invalid: {
                            status: 409,
                            code: "CAMPAIGN_NOT_OPEN",
                            message: "Impossibile inizializzare uno scenario se la campagna non è aperta.",
                        },
                    } as const;
                }
                if (!lifecycle.campaignId) {
                    return {
                        invalid: {
                            status: 409,
                            code: "CAMPAIGN_ID_MISSING",
                            message: "Campagna attiva non trovata per il perimetro corrente.",
                        },
                    } as const;
                }
                const activeCampaignId = lifecycle.campaignId;
                const applicationsColumns = await getTableColumns(client, "applications");
                const applicationsHasCampaignId = applicationsColumns.has("campaign_id");

                const insertedApplications = await client.query(
                    applicationsHasCampaignId
                        ? `
                        insert into applications (user_id, position_id, priority, company_id, perimeter_id, campaign_id)
                        select user_id, position_id, priority, company_id, perimeter_id, $4
                        from test_scenario_applications
                        where scenario_id = $1
                          and company_id = $2
                          and perimeter_id = $3
                        on conflict (user_id, position_id) do nothing
                        `
                        : `
                        insert into applications (user_id, position_id, priority, company_id, perimeter_id)
                        select user_id, position_id, priority, company_id, perimeter_id
                        from test_scenario_applications
                        where scenario_id = $1
                          and company_id = $2
                          and perimeter_id = $3
                        on conflict (user_id, position_id) do nothing
                        `,
                    applicationsHasCampaignId
                        ? [scenarioId, companyId, perimeterId, activeCampaignId]
                        : [scenarioId, companyId, perimeterId]
                );

                const forcedAvailable = await client.query(
                    `
                  update users
                  set availability_status = 'available',
                      is_reserved = true,
                      show_position = true
                  where id in (
                select distinct user_id
                from test_scenario_applications
                where scenario_id = $1
                  and company_id = $2
                  and perimeter_id = $3

                union

                select distinct p.occupied_by
                from test_scenario_applications tsa
                join positions p on p.id = tsa.position_id
                where tsa.scenario_id = $1
                  and tsa.company_id = $2
                  and tsa.perimeter_id = $3
                  and p.occupied_by is not null
                  )
                  and company_id = $2
                  and coalesce(perimeter_id, home_perimeter_id) = $3
                  `,
                    [scenarioId, companyId, perimeterId]
                );

                // Backward-compatible: tracking table may be missing in environments where
                // the latest migration has not yet been applied.
                const tsiuColumns = await getTableColumns(client, "test_scenario_initialized_users");
                if (
                    tsiuColumns.size > 0
                    && tsiuColumns.has("company_id")
                    && tsiuColumns.has("perimeter_id")
                    && tsiuColumns.has("campaign_id")
                    && tsiuColumns.has("scenario_id")
                    && tsiuColumns.has("user_id")
                ) {
                    await client.query(
                        `
                        insert into test_scenario_initialized_users
                          (company_id, perimeter_id, campaign_id, scenario_id, user_id)
                        select distinct $2, $3, $4, $1, x.user_id
                        from (
                          select tsa.user_id
                          from test_scenario_applications tsa
                          where tsa.scenario_id = $1
                            and tsa.company_id = $2
                            and tsa.perimeter_id = $3

                          union

                          select p.occupied_by as user_id
                          from test_scenario_applications tsa
                          join positions p on p.id = tsa.position_id
                          where tsa.scenario_id = $1
                            and tsa.company_id = $2
                            and tsa.perimeter_id = $3
                            and p.occupied_by is not null
                        ) x
                        on conflict (company_id, perimeter_id, campaign_id, user_id)
                        do update set
                          scenario_id = excluded.scenario_id,
                          initialized_at = now()
                        `,
                        [scenarioId, companyId, perimeterId, activeCampaignId]
                    );
                }

                await client.query(
                    `
                    update users u
                    set application_count = coalesce(x.cnt, 0)
                    from (
                        select u2.id as user_id, count(a.*)::int as cnt
                        from users u2
                        left join applications a on a.user_id = u2.id and a.company_id = $1 and a.perimeter_id = $2
                        ${applicationsHasCampaignId ? "and a.campaign_id = $3" : ""}
                        where u2.company_id = $1
                          and coalesce(u2.perimeter_id, u2.home_perimeter_id) = $2
                        group by u2.id
                    ) x
                    where u.id = x.user_id
                    `,
                    applicationsHasCampaignId
                        ? [companyId, perimeterId, activeCampaignId]
                        : [companyId, perimeterId]
                );

                await client.query(
                    `
                    update users
                    set application_count = 0
                    where company_id = $1
                      and coalesce(perimeter_id, home_perimeter_id) = $2
                      and id not in (
                        select distinct user_id from applications where company_id = $1 and perimeter_id = $2
                        ${applicationsHasCampaignId ? "and campaign_id = $3" : ""}
                      )
                    `,
                    applicationsHasCampaignId
                        ? [companyId, perimeterId, activeCampaignId]
                        : [companyId, perimeterId]
                );

                // Business rule: initializing a test scenario while campaign is open
                // must overwrite reservation counts with the current initialized state.
                const reservedUsersRes = await client.query<{ cnt: string }>(
                    `
                    select count(*)::text as cnt
                    from users
                    where company_id = $1
                      and coalesce(perimeter_id, home_perimeter_id) = $2
                      and (
                        coalesce(is_reserved, false) = true
                        or availability_status = 'available'
                      )
                    `,
                    [companyId, perimeterId]
                );
                const reservedUsersCount = Number(reservedUsersRes.rows[0]?.cnt ?? 0);
                await client.query(
                    `
                    update campaigns
                    set reserved_users_count = $2
                    where id = $1
                    `,
                    [activeCampaignId, reservedUsersCount]
                );

                return {
                    insertedApplications: insertedApplications.rowCount ?? 0,
                    activatedUsers: forcedAvailable.rowCount ?? 0,
                    reservedUsersCount,
                };
            });

            if ("invalid" in result && result.invalid) {
                return res.status(result.invalid.status).json({
                    ok: false,
                    code: result.invalid.code,
                    error: result.invalid.message,
                    correlationId,
                });
            }

            invalidateMapCache();

            await audit(
                "scenario_initialize",
                r.user.id,
                { scenarioId },
                result,
                correlationId
            );

            return res.status(200).json({ ok: true, result, correlationId });
        } catch (e: any) {
            const message = String(e?.message ?? e);
            await audit(
                "scenario_initialize",
                r.user.id,
                { scenarioId },
                { error: message },
                correlationId
            );
            return res.status(500).json({ ok: false, error: message || "Initialize failed", correlationId });
        }
    }
);

/**
 * POST /api/admin/users/invite
 */
adminRouter.post("/users/invite", async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const { email, full_name, first_name, last_name, location_id, access_role } = req.body ?? {};
        const firstName = String(first_name ?? "").trim();
        const lastName = String(last_name ?? "").trim();
        const normalizedFullName = String(full_name ?? `${firstName} ${lastName}`).trim().replace(/\s+/g, " ");
        const normalizedEmail = String(email ?? "").trim().toLowerCase();
        const normalizedAccessRole =
            access_role === "admin" || access_role === "admin_user" ? access_role : "user";

        if (!normalizedEmail || !normalizedFullName) {
            return res.status(400).json({ ok: false, error: "missing email or user name", correlationId });
        }

        const { data, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
            normalizedEmail,
            {
                data: {
                    first_name: firstName || null,
                    last_name: lastName || null,
                    full_name: normalizedFullName,
                    location_id: location_id ?? null,
                },
            }
        );

        if (inviteError) {
            return res.status(500).json({ ok: false, error: inviteError.message, correlationId });
        }

        const userId = data.user?.id;
        if (!userId) {
            return res.status(500).json({ ok: false, error: "invite returned no user id", correlationId });
        }

        await pool.query(
            `
            insert into users (
              id, email, first_name, last_name, full_name, location_id, availability_status, application_count,
              company_id, perimeter_id, home_perimeter_id, created_by, updated_by
            )
            values ($1, $2, $3, $4, $5, $6, 'inactive', 0, $7, $8, $8, $9, $9)
            on conflict (id) do update
              set email = excluded.email,
                  first_name = excluded.first_name,
                  last_name = excluded.last_name,
                  full_name = excluded.full_name,
                  location_id = excluded.location_id,
                  company_id = excluded.company_id,
                  perimeter_id = excluded.perimeter_id,
                  home_perimeter_id = excluded.home_perimeter_id,
                  updated_by = excluded.updated_by
            `,
            [userId, normalizedEmail, firstName || null, lastName || null, normalizedFullName, location_id ?? null, companyId, perimeterId, r.user.id]
        );

        await pool.query(
            `
            insert into perimeter_memberships (company_id, perimeter_id, user_id, access_role, status, created_by)
            values ($1, $2, $3, $4, 'active', $5)
            on conflict (perimeter_id, user_id) do update
              set access_role = excluded.access_role,
                  status = excluded.status
            `,
            [companyId, perimeterId, userId, normalizedAccessRole, r.user.id]
        );

        await audit("admin_invite_user", r.user.id, { email: normalizedEmail, full_name: normalizedFullName }, { userId }, correlationId);

        return res.status(200).json({
            ok: true,
            user: {
                id: userId,
                email: normalizedEmail,
                first_name: firstName || null,
                last_name: lastName || null,
                full_name: normalizedFullName,
                access_role: normalizedAccessRole,
            },
            correlationId,
        });
    } catch (e: any) {
        await audit(
            "admin_invite_user",
            (req as any)?.user?.id ?? "unknown",
            { email: req.body?.email ?? null },
            { error: String(e?.message ?? e) },
            correlationId
        );
        return res.status(500).json({ ok: false, error: "Invite failed", detail: String(e?.message ?? e), correlationId });
    }
});

/**
 * GET /api/admin/users/active
 */
adminRouter.get("/users/active", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const { rows } = await pool.query(
            `
      select
        id,
        full_name,
        email,
        availability_status,
        location_id,
        fixed_location,
        role_id
      from users
      where availability_status = 'available'
        and company_id = $1
        and coalesce(perimeter_id, home_perimeter_id) = $2
      order by full_name nulls last, id
      `
            ,
            [companyId, perimeterId]
        );

        return res.json({
            ok: true,
            users: rows,
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});

/**
 * POST /api/admin/users/:id/deactivate
 * Legacy endpoint kept for compatibility.
 * Manual availability changes are no longer allowed in lifecycle RC2.
 */
adminRouter.post(
    "/users/:id/deactivate",
    async (req: Request, res: Response) => {
        const correlationId = (req as any).correlationId;
        return res.status(409).json({
            ok: false,
            code: "MANUAL_AVAILABILITY_DISABLED",
            error: "User availability is managed only by reservation/campaign lifecycle",
            correlationId,
        });
    }
);

/**
 * POST /api/admin/config/max-applications
 */
adminRouter.post("/config/max-applications", async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({
                error: "PERIMETER_CONTEXT_REQUIRED",
                correlationId,
            });
        }
        const { maxApplications } = req.body ?? {};
        const newMax = Number(maxApplications);

        if (!Number.isFinite(newMax) || newMax < 1 || newMax > 50) {
            return res.status(400).json({
                error: "Invalid maxApplications. Must be a number between 1 and 50.",
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            const oldRow = await client.query(
                `select max_applications from app_config where singleton = true and company_id = $1 and perimeter_id = $2 limit 1`,
                [companyId, perimeterId]
            );
            const oldMax: number | null = oldRow.rows?.[0]?.max_applications ?? null;

            await client.query(
                `update app_config set max_applications = $1 where singleton = true and company_id = $2 and perimeter_id = $3`,
                [newMax, companyId, perimeterId]
            );

            if (oldMax !== null && newMax >= oldMax) {
                return {
                    oldMax,
                    newMax,
                    rebalance: { performed: false, reason: "max did not decrease" },
                };
            }

            // Delegate to named function (replaces DB trigger trg_rebalance_applications_on_max_change).
            const rebalanceResult = await rebalanceApplicationsAfterMaxChange(
                client, newMax, companyId, perimeterId
            );

            return {
                oldMax,
                newMax,
                rebalance: {
                    performed: true,
                    deleted: rebalanceResult.deleted,
                    prioritiesUpdated: rebalanceResult.prioritiesUpdated,
                },
            };
        });

        invalidateMapCache();

        await audit(
            "config_update_max_applications",
            r.user.id,
            { newMax },
            out,
            correlationId
        );

        return res.status(200).json({ ok: true, out, correlationId });
    } catch (e: any) {
        await audit(
            "config_update_max_applications",
            (req as any)?.user?.id ?? "unknown",
            { body: req.body ?? {} },
            { error: String(e?.message ?? e) },
            (req as any).correlationId
        );

        return res.status(500).json({
            error: "Update max applications failed",
            detail: String(e?.message ?? e),
            correlationId: (req as any).correlationId,
        });
    }
});

/**
 * POST /api/admin/users/reset-active
 * HARNESS ONLY — dev/staging. Deletes ALL applications and sets all users
 * inactive. Intended for resetting demo/test environments. Not available in production.
 */
adminRouter.post("/users/reset-active", async (req: Request, res: Response) => {
    if (harnessOnly(req, res)) return;
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const out = await withTx(async (client) => {
            const delApps = await client.query(`delete from applications where company_id = $1 and perimeter_id = $2`, [companyId, perimeterId]);
            const updUsers = await client.query(`
                update users
                set availability_status = 'inactive',
                    application_count = 0
                where (availability_status is distinct from 'inactive'
                   or application_count is distinct from 0)
                  and company_id = $1
                  and coalesce(perimeter_id, home_perimeter_id) = $2
            `, [companyId, perimeterId]);

            return {
                applicationsDeleted: delApps.rowCount,
                usersUpdated: updUsers.rowCount,
            };
        });

        invalidateMapCache();

        await audit("users_reset_active", r.user.id, {}, out, correlationId);
        return res.status(200).json({ ok: true, out, correlationId });
    } catch (e: any) {
        await audit(
            "users_reset_active",
            r.user.id,
            {},
            { error: String(e?.message ?? e) },
            correlationId
        );

        return res.status(500).json({
            error: "Reset active failed",
            detail: String(e?.message ?? e),
            correlationId,
        });
    }
});

async function readLifecycleSnapshot(client: import("pg").PoolClient, companyId: string, perimeterId: string) {
    const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId);

    const [reservedUsersRes, availableUsersRes] = await Promise.all([
        client.query<{ cnt: string }>(
            `
            select count(*)::text as cnt
            from users
            where company_id = $1
              and coalesce(perimeter_id, home_perimeter_id) = $2
              and (
                coalesce(is_reserved, false) = true
                or availability_status = 'available'
              )
            `,
            [companyId, perimeterId]
        ),
        client.query<{ cnt: string }>(
            `
            select count(*)::text as cnt
            from users
            where company_id = $1
              and coalesce(perimeter_id, home_perimeter_id) = $2
              and availability_status = 'available'
            `,
            [companyId, perimeterId]
        ),
    ]);

    return {
        campaign_status: lifecycle.campaignStatus,
        reservations_status: lifecycle.reservationsStatus,
        campaign_id: lifecycle.campaignId,
        reserved_users_count: Number(reservedUsersRes.rows[0]?.cnt ?? 0),
        available_users_count: Number(availableUsersRes.rows[0]?.cnt ?? 0),
    };
}

/**
 * GET /api/admin/campaign-status
 * Returns lifecycle status for campaign + reservation window.
 */
adminRouter.get("/campaign-status", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId;
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({
                ok: false,
                error: { code: "PERIMETER_CONTEXT_REQUIRED", message: "Perimeter context required" },
                correlationId,
            });
        }
        const out = await withTx(async (client) => {
            return readLifecycleSnapshot(client, companyId, perimeterId);
        });
        return res.json({ ok: true, ...out, correlationId });
    } catch (e: any) {
        return res.status(500).json({
            ok: false,
            error: { code: "CAMPAIGN_STATUS_FAILED", message: String(e?.message ?? e) },
            correlationId,
        });
    }
});

/**
 * PATCH /api/admin/campaign-status
 * Legacy endpoint intentionally disabled: use explicit lifecycle endpoints.
 */
adminRouter.patch("/campaign-status", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId;
    return res.status(410).json({
        ok: false,
        code: "DEPRECATED_ENDPOINT",
        error: "Use /api/admin/reservations/* and /api/admin/campaign/* endpoints",
        correlationId,
    });
});

/**
 * POST /api/admin/reservations/open
 */
adminRouter.post("/reservations/open", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({
                ok: false,
                error: { code: "PERIMETER_CONTEXT_REQUIRED", message: "Perimeter context required" },
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            const result = await openReservations(client, companyId, perimeterId);
            if ("error" in result) return { invalid: result.error };
            const snapshot = await readLifecycleSnapshot(client, companyId, perimeterId);
            return { snapshot };
        });

        if ("invalid" in out && out.invalid) {
            const invalid = out.invalid;
            return res.status(invalid.status).json({
                ok: false,
                error: { code: invalid.code, message: invalid.message },
                correlationId,
            });
        }

        invalidateMapCache();
        await audit(
            "admin_open_reservations",
            r.user.id,
            { company_id: companyId, perimeter_id: perimeterId },
            out.snapshot,
            correlationId,
            { companyId, perimeterId }
        );
        return res.json({ ok: true, ...(out.snapshot ?? {}), correlationId });
    } catch (e: any) {
        return res.status(500).json({
            ok: false,
            error: { code: "OPEN_RESERVATIONS_FAILED", message: String(e?.message ?? e) },
            correlationId,
        });
    }
});

/**
 * POST /api/admin/reservations/close
 */
adminRouter.post("/reservations/close", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({
                ok: false,
                error: { code: "PERIMETER_CONTEXT_REQUIRED", message: "Perimeter context required" },
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            const result = await closeReservations(client, companyId, perimeterId);
            if ("error" in result) return { invalid: result.error };
            const snapshot = await readLifecycleSnapshot(client, companyId, perimeterId);
            return { snapshot };
        });

        if ("invalid" in out && out.invalid) {
            const invalid = out.invalid;
            return res.status(invalid.status).json({
                ok: false,
                error: { code: invalid.code, message: invalid.message },
                correlationId,
            });
        }

        invalidateMapCache();
        await audit(
            "admin_close_reservations",
            r.user.id,
            { company_id: companyId, perimeter_id: perimeterId },
            out.snapshot,
            correlationId,
            { companyId, perimeterId }
        );
        return res.json({ ok: true, ...(out.snapshot ?? {}), correlationId });
    } catch (e: any) {
        return res.status(500).json({
            ok: false,
            error: { code: "CLOSE_RESERVATIONS_FAILED", message: String(e?.message ?? e) },
            correlationId,
        });
    }
});

/**
 * POST /api/admin/campaign/open
 */
adminRouter.post("/campaign/open", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({
                ok: false,
                error: { code: "PERIMETER_CONTEXT_REQUIRED", message: "Perimeter context required" },
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            const result = await openCampaign(client, companyId, perimeterId);
            if ("error" in result) return { invalid: result.error };
            const snapshot = await readLifecycleSnapshot(client, companyId, perimeterId);
            return { snapshot, usersUpdated: result.usersUpdated };
        });

        if ("invalid" in out && out.invalid) {
            const invalid = out.invalid;
            return res.status(invalid.status).json({
                ok: false,
                error: { code: invalid.code, message: invalid.message },
                correlationId,
            });
        }

        invalidateMapCache();
        await audit(
            "admin_open_campaign",
            r.user.id,
            { company_id: companyId, perimeter_id: perimeterId },
            { ...(out.snapshot ?? {}), usersUpdated: out.usersUpdated },
            correlationId,
            { companyId, perimeterId }
        );
        return res.json({ ok: true, ...(out.snapshot ?? {}), correlationId });
    } catch (e: any) {
        return res.status(500).json({
            ok: false,
            error: { code: "OPEN_CAMPAIGN_FAILED", message: String(e?.message ?? e) },
            correlationId,
        });
    }
});

/**
 * POST /api/admin/campaign/close
 */
adminRouter.post("/campaign/close", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({
                ok: false,
                error: { code: "PERIMETER_CONTEXT_REQUIRED", message: "Perimeter context required" },
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            const result = await closeCampaign(client, companyId, perimeterId);
            if ("error" in result) return { invalid: result.error };
            const snapshot = await readLifecycleSnapshot(client, companyId, perimeterId);
            return {
                snapshot,
                usersReset: result.usersReset,
                applicationsDeleted: result.applicationsDeleted,
                testScenarioUsersReset: result.testScenarioUsersReset,
            };
        });

        if ("invalid" in out && out.invalid) {
            const invalid = out.invalid;
            return res.status(invalid.status).json({
                ok: false,
                error: { code: invalid.code, message: invalid.message },
                correlationId,
            });
        }

        invalidateMapCache();
        await audit(
            "admin_close_campaign",
            r.user.id,
            { company_id: companyId, perimeter_id: perimeterId },
            {
                ...(out.snapshot ?? {}),
                usersReset: out.usersReset,
                applicationsDeleted: out.applicationsDeleted,
                testScenarioUsersReset: out.testScenarioUsersReset,
            },
            correlationId,
            { companyId, perimeterId }
        );
        return res.json({ ok: true, ...(out.snapshot ?? {}), correlationId });
    } catch (e: any) {
        return res.status(500).json({
            ok: false,
            error: { code: "CLOSE_CAMPAIGN_FAILED", message: String(e?.message ?? e) },
            correlationId,
        });
    }
});

adminRouter.get("/candidatures", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId: (req as any).correlationId ?? null });
        }
        const lifecycle = await withTx((client) => loadCampaignLifecycle(client, companyId, perimeterId));
        if (lifecycle.campaignStatus !== "open") {
            return res.json({
                ok: true,
                applications: [],
                correlationId: (req as any).correlationId ?? null,
            });
        }

        const { rows } = await pool.query(
            `
      select
        a.id,
        a.priority,
        a.created_at,

        cand.full_name as candidate_full_name,
        cand_role.name as candidate_role_name,
        cand_loc.name as candidate_location_name,

        occ.full_name as occupant_full_name,
        occ_role.name as occupant_role_name,
        occ_loc.name as occupant_location_name,
        occ.department_id as target_department_id,
        target_dpt.name as target_department_name,
        coalesce(
          (
            select json_agg(
              json_build_object('id', rsp.id, 'name', rsp.name)
              order by rsp.name asc
            )
            from user_responsabile_assignments ura
            join responsabili rsp on rsp.id = ura.responsabile_id
            where ura.user_id = occ.id
              and ura.company_id = $1
              and ura.perimeter_id = $2
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
            where uha.user_id = occ.id
              and uha.company_id = $1
              and uha.perimeter_id = $2
          ),
          '[]'::json
        ) as target_hr_managers

      from applications a
      join users cand on cand.id = a.user_id

      join positions p on p.id = a.position_id
      join users occ on occ.id = p.occupied_by

      left join roles cand_role on cand_role.id = cand.role_id
      left join locations cand_loc on cand_loc.id = cand.location_id

      left join roles occ_role on occ_role.id = occ.role_id
      left join locations occ_loc on occ_loc.id = occ.location_id
      left join departments target_dpt on target_dpt.id = occ.department_id

      where a.company_id = $1
        and a.perimeter_id = $2

      order by a.created_at desc
      limit 500
      `
            ,
            [companyId, perimeterId]
        );

        return res.json({
            ok: true,
            applications: rows,
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/candidatures/stats", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const [statsRows, campaignStatus] = await Promise.all([
            pool.query<{
                reserved_count: number;
                active_users_count: number;
                active_users_pct: number;
                avg_applications_per_reserved: number;
            }>(
                `
                with reserved_users as (
                    select u.id
                    from users u
                    where u.company_id = $1
                      and coalesce(u.perimeter_id, u.home_perimeter_id) = $2
                      and (
                        coalesce(u.is_reserved, false) = true
                        or u.availability_status = 'available'
                      )
                ),
                applications_by_user as (
                    select a.user_id, count(*)::int as applications_count
                    from applications a
                    where a.company_id = $1
                      and a.perimeter_id = $2
                    group by a.user_id
                ),
                aggregates as (
                    select
                        count(*)::int as reserved_count,
                        count(*) filter (where coalesce(abu.applications_count, 0) > 0)::int as active_users_count,
                        coalesce(sum(coalesce(abu.applications_count, 0)), 0)::numeric as total_applications
                    from reserved_users ru
                    left join applications_by_user abu on abu.user_id = ru.id
                )
                select
                    reserved_count,
                    active_users_count,
                    case
                        when reserved_count > 0
                            then round((active_users_count::numeric * 100.0) / reserved_count, 1)
                        else 0::numeric
                    end as active_users_pct,
                    case
                        when reserved_count > 0
                            then round(total_applications / reserved_count, 1)
                        else 0::numeric
                    end as avg_applications_per_reserved
                from aggregates
                `,
                [companyId, perimeterId]
            ),
            getCampaignStatus(companyId, perimeterId),
        ]);

        const stats = statsRows.rows[0] ?? {
            reserved_count: 0,
            active_users_count: 0,
            active_users_pct: 0,
            avg_applications_per_reserved: 0,
        };

        return res.json({
            ok: true,
            campaign_id: campaignStatus.campaign_id,
            campaign_status: campaignStatus.campaign_status,
            reservations_status: campaignStatus.reservations_status,
            reserved_count: Number(stats.reserved_count ?? 0),
            active_users_count: Number(stats.active_users_count ?? 0),
            active_users_pct: Number(stats.active_users_pct ?? 0),
            avg_applications_per_reserved: Number(stats.avg_applications_per_reserved ?? 0),
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/users", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const { rows } = await pool.query(
            `
      select
        u.id,
        u.first_name,
        u.last_name,
        u.full_name,
        u.email,
        u.availability_status,
        u.is_reserved,
        case
          when u.availability_status = 'available' then 'available'
          when coalesce(u.is_reserved, false) then 'reserved'
          else 'inactive'
        end as user_state,
        u.location_id,
        l.name as location_name,
        u.fixed_location,
        u.role_id,
        r.name as role_name,
        u.department_id,
        dpt.name as department_name,
        pm.access_role,
        u.application_count,
        coalesce(
          (
            select json_agg(
              json_build_object('id', rsp.id, 'name', rsp.name)
              order by rsp.name asc
            )
            from user_responsabile_assignments ura
            join responsabili rsp on rsp.id = ura.responsabile_id
            where ura.user_id = u.id
              and ura.company_id = $1
              and ura.perimeter_id = $2
          ),
          '[]'::json
        ) as responsabili,
        coalesce(
          (
            select json_agg(
              json_build_object('id', hr.id, 'name', hr.name)
              order by hr.name asc
            )
            from user_hr_assignments uha
            join hr_managers hr on hr.id = uha.hr_manager_id
            where uha.user_id = u.id
              and uha.company_id = $1
              and uha.perimeter_id = $2
          ),
          '[]'::json
        ) as hr_managers,
        u.company_id,
        u.home_perimeter_id
      from perimeter_memberships pm
      join users u on u.id = pm.user_id
      left join locations l on l.id = u.location_id
      left join roles r on r.id = u.role_id
      left join departments dpt on dpt.id = u.department_id
      where pm.company_id = $1
        and pm.perimeter_id = $2
        and u.company_id = $1
        and coalesce(u.perimeter_id, u.home_perimeter_id) = $2
        and coalesce(pm.status, 'active') = 'active'
      order by u.last_name nulls last, u.first_name nulls last, u.full_name nulls last, u.id
      `
            ,
            [companyId, perimeterId]
        );

        return res.json({
            ok: true,
            users: rows,
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});

/**
 * GET /api/admin/users/import-template
 * Download Excel template for bulk user import scoped to current company/perimeter.
 */
adminRouter.get("/users/import-template", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({
                ok: false,
                error: "PERIMETER_CONTEXT_REQUIRED",
                correlationId: (req as any).correlationId ?? null,
            });
        }

        const [rolesRes, locationsRes] = await Promise.all([
            pool.query<{ name: string }>(
                `select name from roles order by name asc`
            ),
            pool.query<{ name: string }>(
                `select name from locations order by name asc`
            ),
        ]);

        const roleNames = rolesRes.rows.map((r) => String(r.name ?? "").trim()).filter(Boolean);
        const locationNames = locationsRes.rows.map((l) => String(l.name ?? "").trim()).filter(Boolean);
        const fixedLocationValues = ["Sì", "No"];

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Utenti");
        const listsSheet = workbook.addWorksheet("_Liste");
        listsSheet.state = "veryHidden";
        sheet.columns = [
            { header: "Nome", key: "nome", width: 24 },
            { header: "Cognome", key: "cognome", width: 24 },
            { header: "Email", key: "email", width: 32 },
            { header: "HR Responsabile", key: "hrResponsabile", width: 28 },
            { header: "Ruolo", key: "ruolo", width: 26 },
            { header: "Sede", key: "sede", width: 26 },
            { header: "Sede vincolante", key: "sedeVincolante", width: 18 },
        ];

        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true };
        headerRow.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFD9EAF7" },
        };
        headerRow.alignment = { vertical: "middle", horizontal: "center" };

        const sampleRole = roleNames[0] ?? "Ruolo esempio";
        const sampleLocation = locationNames[0] ?? "Sede esempio";
        const sampleRow = sheet.addRow([
            "Mario",
            "Rossi",
            "mario.rossi@azienda.it",
            "Anna Verdi",
            sampleRole,
            sampleLocation,
            "No",
        ]);
        sampleRow.font = { italic: true, color: { argb: "FF7A7A7A" } };

        const safeRoleNames = roleNames.length > 0 ? roleNames : [""];
        const safeLocationNames = locationNames.length > 0 ? locationNames : [""];
        const safeFixedLocationValues = fixedLocationValues.length > 0 ? fixedLocationValues : [""];

        safeRoleNames.forEach((name, index) => {
            listsSheet.getCell(`A${index + 1}`).value = name;
        });
        safeLocationNames.forEach((name, index) => {
            listsSheet.getCell(`B${index + 1}`).value = name;
        });
        safeFixedLocationValues.forEach((name, index) => {
            listsSheet.getCell(`C${index + 1}`).value = name;
        });

        workbook.definedNames.add("_ruoli_import", `_Liste!$A$1:$A$${safeRoleNames.length}`);
        workbook.definedNames.add("_sedi_import", `_Liste!$B$1:$B$${safeLocationNames.length}`);
        workbook.definedNames.add("_sede_vincolante_import", `_Liste!$C$1:$C$${safeFixedLocationValues.length}`);

        for (let rowNumber = 2; rowNumber <= 500; rowNumber += 1) {
            const roleCell = sheet.getCell(`E${rowNumber}`);
            roleCell.dataValidation = {
                type: "list",
                allowBlank: true,
                formulae: ["=_ruoli_import"],
                showErrorMessage: true,
                errorTitle: "Ruolo non valido",
                error: "Seleziona un ruolo tra quelli disponibili nel menu a tendina.",
            };

            const locationCell = sheet.getCell(`F${rowNumber}`);
            locationCell.dataValidation = {
                type: "list",
                allowBlank: true,
                formulae: ["=_sedi_import"],
                showErrorMessage: true,
                errorTitle: "Sede non valida",
                error: "Seleziona una sede tra quelle disponibili nel menu a tendina.",
            };

            const fixedLocationCell = sheet.getCell(`G${rowNumber}`);
            fixedLocationCell.dataValidation = {
                type: "list",
                allowBlank: true,
                formulae: ["=_sede_vincolante_import"],
                showErrorMessage: true,
                errorTitle: "Valore non valido",
                error: "Usa Sì oppure No.",
            };
        }

        const fileBuffer = await workbook.xlsx.writeBuffer();
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "Content-Disposition",
            "attachment; filename=\"template_importazione_utenti.xlsx\""
        );
        return res.status(200).send(fileBuffer);
    } catch (e: any) {
        return res.status(500).json({
            ok: false,
            error: "IMPORT_TEMPLATE_GENERATION_FAILED",
            detail: String(e?.message ?? e),
            correlationId: (req as any).correlationId ?? null,
        });
    }
});

/**
 * POST /api/admin/users/import
 * Multipart upload: field "file" (.xlsx)
 */
adminRouter.post(
    "/users/import",
    requireOperationalPerimeterAdmin,
    uploadExcel.single("file"),
    async (req: Request, res: Response) => {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId;
        const file = (req as Request & { file?: Express.Multer.File }).file;

        try {
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }
            if (!file) {
                return res.status(400).json({ ok: false, error: "FILE_REQUIRED", correlationId });
            }
            if (!String(file.originalname ?? "").toLowerCase().endsWith(".xlsx")) {
                return res.status(400).json({ ok: false, error: "INVALID_FILE_TYPE", detail: "Carica un file .xlsx", correlationId });
            }

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.read(Readable.from(file.buffer));
            const sheet = workbook.getWorksheet("Utenti") ?? workbook.worksheets[0];
            if (!sheet) {
                return res.status(400).json({ ok: false, error: "WORKSHEET_NOT_FOUND", correlationId });
            }

            const [rolesRes, locationsRes] = await Promise.all([
                pool.query<{ id: string; name: string }>(
                    `
                    select id, name
                    from roles
                    where company_id = $1
                      and perimeter_id = $2
                    `,
                    [companyId, perimeterId]
                ),
                pool.query<{ id: string; name: string }>(
                    `
                    select id, name
                    from locations
                    where company_id = $1
                      and perimeter_id = $2
                    `,
                    [companyId, perimeterId]
                ),
            ]);

            const roleByName = new Map<string, string>();
            for (const role of rolesRes.rows) {
                roleByName.set(String(role.name ?? "").trim(), role.id);
            }

            const locationByName = new Map<string, string>();
            for (const location of locationsRes.rows) {
                locationByName.set(String(location.name ?? "").trim(), location.id);
            }

            let total = 0;
            let imported = 0;
            const errors: BulkImportErrorItem[] = [];

            for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
                const row = sheet.getRow(rowNumber);
                const nome = normalizeImportCellValue(row.getCell(1).value);
                const cognome = normalizeImportCellValue(row.getCell(2).value);
                const emailRaw = normalizeImportCellValue(row.getCell(3).value);
                const hrResponsabile = normalizeImportCellValue(row.getCell(4).value);
                const ruolo = normalizeImportCellValue(row.getCell(5).value);
                const sede = normalizeImportCellValue(row.getCell(6).value);
                const sedeVincolanteRaw = normalizeImportCellValue(row.getCell(7).value);

                const isEmptyRow = [nome, cognome, emailRaw, hrResponsabile, ruolo, sede, sedeVincolanteRaw]
                    .every((value) => !value);
                if (isEmptyRow) continue;

                const loweredEmailRaw = emailRaw.toLowerCase();
                const isSampleRow = loweredEmailRaw.includes("azienda.it") || nome.toLowerCase() === "mario";
                if (isSampleRow) continue;

                total += 1;

                if (!nome) {
                    errors.push({ row: rowNumber, email: emailRaw, error: "Nome mancante" });
                    continue;
                }
                if (!cognome) {
                    errors.push({ row: rowNumber, email: emailRaw, error: "Cognome mancante" });
                    continue;
                }
                if (!emailRaw) {
                    errors.push({ row: rowNumber, email: "", error: "Email mancante" });
                    continue;
                }

                let email: string;
                try {
                    email = normalizeEmailInput(emailRaw);
                } catch {
                    errors.push({ row: rowNumber, email: emailRaw, error: "Email non valida" });
                    continue;
                }

                if (!isValidEmailFormat(email)) {
                    errors.push({ row: rowNumber, email, error: "Email non valida" });
                    continue;
                }

                if (!ruolo) {
                    errors.push({ row: rowNumber, email, error: "Ruolo mancante" });
                    continue;
                }
                if (!sede) {
                    errors.push({ row: rowNumber, email, error: "Sede mancante" });
                    continue;
                }

                const roleId = roleByName.get(ruolo);
                if (!roleId) {
                    errors.push({ row: rowNumber, email, error: `Ruolo '${ruolo}' non trovato` });
                    continue;
                }

                const locationId = locationByName.get(sede);
                if (!locationId) {
                    errors.push({ row: rowNumber, email, error: `Sede '${sede}' non trovata` });
                    continue;
                }

                const fixedLocation = parseFixedLocation(sedeVincolanteRaw);
                if (fixedLocation === null) {
                    errors.push({ row: rowNumber, email, error: "Sede vincolante deve essere 'Sì' o 'No'" });
                    continue;
                }

                const fullName = `${nome} ${cognome}`.trim().replace(/\s+/g, " ");

                try {
                    const authUserId = await resolveOrInviteAuthUserId({
                        email,
                        firstName: nome,
                        lastName: cognome,
                        fullName,
                    });

                    await withTx(async (client) => {
                        await client.query(
                            `
                            insert into users (
                                id,
                                first_name,
                                last_name,
                                full_name,
                                email,
                                role_id,
                                location_id,
                                fixed_location,
                                company_id,
                                perimeter_id,
                                home_perimeter_id,
                                availability_status,
                                created_by,
                                updated_by,
                                application_count
                            )
                            values (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'inactive', $11, $11, 0
                            )
                            on conflict (id) do update
                              set first_name = excluded.first_name,
                                  last_name = excluded.last_name,
                                  full_name = excluded.full_name,
                                  email = excluded.email,
                                  role_id = excluded.role_id,
                                  location_id = excluded.location_id,
                                  fixed_location = excluded.fixed_location,
                                  company_id = excluded.company_id,
                                  perimeter_id = excluded.perimeter_id,
                                  home_perimeter_id = excluded.home_perimeter_id,
                                  availability_status = 'inactive',
                                  updated_by = excluded.updated_by
                            `,
                            [authUserId, nome, cognome, fullName, email, roleId, locationId, fixedLocation, companyId, perimeterId, r.user.id]
                        );

                        await client.query(
                            `
                            insert into perimeter_memberships (
                                user_id,
                                company_id,
                                perimeter_id,
                                access_role,
                                status,
                                created_by
                            )
                            values ($1, $2, $3, 'user', 'active', $4)
                            on conflict (perimeter_id, user_id) do update
                              set company_id = excluded.company_id,
                                  access_role = excluded.access_role,
                                  status = excluded.status
                            `,
                            [authUserId, companyId, perimeterId, r.user.id]
                        );
                    });

                    // TODO: "HR Responsabile" va persistito come nota strutturata quando avremo un campo dedicato.
                    void hrResponsabile;
                    imported += 1;
                } catch (e: any) {
                    errors.push({
                        row: rowNumber,
                        email,
                        error: String(e?.message ?? "Errore durante importazione utente"),
                    });
                }
            }

            await audit(
                "bulk_user_import",
                r.user.id,
                { companyId, perimeterId },
                { total, imported, errors: errors.length },
                correlationId
            );

            return res.status(200).json({
                total,
                imported,
                errors,
                correlationId,
            });
        } catch (e: any) {
            return res.status(500).json({
                ok: false,
                error: "BULK_USER_IMPORT_FAILED",
                detail: String(e?.message ?? e),
                correlationId,
            });
        }
    }
);

adminRouter.post("/users", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId: (req as any).correlationId ?? null });
        }
        const correlationId = (req as any).correlationId;
        const { full_name, email } = req.body ?? {};
        if (!full_name || !email) {
            return res.status(400).json({ ok: false, error: "missing full_name/email", correlationId });
        }

        const { rows } = await pool.query(
            `
      insert into users (full_name, email, availability_status, company_id, perimeter_id, home_perimeter_id)
      values ($1, $2, 'inactive', $3, $4, $4)
      returning id, full_name, email, availability_status, location_id, fixed_location, role_id, company_id, perimeter_id
      `,
            [String(full_name), String(email), companyId, perimeterId]
        );

        invalidateMapCache();
        return res.status(201).json({ ok: true, user: rows[0], correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/users/:id", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const userId = String(req.params.id ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        if (!userId) {
            return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED", correlationId });
        }

        const { rows } = await pool.query(
            `
            select
              u.id,
              u.first_name,
              u.last_name,
              u.full_name,
              u.email,
              u.availability_status,
              u.is_reserved,
              case
                when u.availability_status = 'available' then 'available'
                when coalesce(u.is_reserved, false) then 'reserved'
                else 'inactive'
              end as user_state,
              u.location_id,
              l.name as location_name,
              u.fixed_location,
              u.role_id,
              r.name as role_name,
              u.department_id,
              dpt.name as department_name,
              pm.access_role,
              u.application_count,
              coalesce(
                (
                  select json_agg(
                    json_build_object('id', rsp.id, 'name', rsp.name)
                    order by rsp.name asc
                  )
                  from user_responsabile_assignments ura
                  join responsabili rsp on rsp.id = ura.responsabile_id
                  where ura.user_id = u.id
                    and ura.company_id = $1
                    and ura.perimeter_id = $2
                ),
                '[]'::json
              ) as responsabili,
              coalesce(
                (
                  select json_agg(
                    json_build_object('id', hr.id, 'name', hr.name)
                    order by hr.name asc
                  )
                  from user_hr_assignments uha
                  join hr_managers hr on hr.id = uha.hr_manager_id
                  where uha.user_id = u.id
                    and uha.company_id = $1
                    and uha.perimeter_id = $2
                ),
                '[]'::json
              ) as hr_managers
            from perimeter_memberships pm
            join users u on u.id = pm.user_id
            left join locations l on l.id = u.location_id
            left join roles r on r.id = u.role_id
            left join departments dpt on dpt.id = u.department_id
            where pm.company_id = $1
              and pm.perimeter_id = $2
              and u.company_id = $1
              and coalesce(u.perimeter_id, u.home_perimeter_id) = $2
              and coalesce(pm.status, 'active') = 'active'
              and u.id = $3
            limit 1
            `,
            [companyId, perimeterId, userId]
        );

        const user = rows[0] ?? null;
        if (!user) {
            return res.status(404).json({ ok: false, error: "USER_NOT_FOUND", correlationId });
        }

        return res.json({ ok: true, user, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.delete("/users/:id", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const userId = req.params.id;
        const { companyId, perimeterId } = getTenantScope(req);

        await pool.query(
            `delete from applications where user_id = $1 and company_id = $2 and perimeter_id = $3`,
            [userId, companyId, perimeterId]
        );

        const del = await pool.query(
            `delete from users where id = $1 and company_id = $2 and coalesce(perimeter_id, home_perimeter_id) = $3`,
            [userId, companyId, perimeterId]
        );

        invalidateMapCache();
        return res.json({ ok: true, deleted: del.rowCount ?? 0, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.patch("/users/:id", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const userId = req.params.id;
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);

        const {
            availability_status,
            first_name,
            last_name,
            email,
            role_id,
            department_id,
            location_id,
            fixed_location,
            access_role,
        } = req.body ?? {};

        const existingUserRes = await pool.query(
            `
            select id, first_name, last_name
            from users
            where id = $1
              and company_id = $2
              and coalesce(perimeter_id, home_perimeter_id) = $3
            limit 1
            `,
            [userId, companyId, perimeterId]
        );
        const existingUser = existingUserRes.rows[0] ?? null;
        if (!existingUser) {
            return res.status(404).json({ ok: false, error: "USER_NOT_FOUND", correlationId });
        }

        const fields: string[] = [];
        const values: any[] = [];
        let i = 1;

        const push = (name: string, value: any) => {
            fields.push(`${name} = $${i++}`);
            values.push(value);
        };

        if (availability_status !== undefined) {
            return res.status(409).json({
                ok: false,
                code: "MANUAL_AVAILABILITY_DISABLED",
                error: "availability_status is lifecycle-managed and cannot be patched manually",
                correlationId,
            });
        }

        const normalizeNullableText = (value: unknown): string | null => {
            if (typeof value !== "string") return null;
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
        };

        if (first_name !== undefined) {
            push("first_name", normalizeNullableText(first_name));
        }
        if (last_name !== undefined) {
            push("last_name", normalizeNullableText(last_name));
        }
        if (email !== undefined) {
            const normalizedEmail = normalizeEmailInput(email);
            if (normalizedEmail && !isValidEmailFormat(normalizedEmail)) {
                return res.status(400).json({ ok: false, error: "invalid email format", correlationId });
            }
            push("email", normalizedEmail);
        }
        if (department_id !== undefined) push("department_id", department_id || null);
        if (location_id !== undefined) push("location_id", location_id || null);
        if (fixed_location !== undefined) push("fixed_location", !!fixed_location);
        if (role_id !== undefined) push("role_id", role_id || null);

        if (first_name !== undefined || last_name !== undefined) {
            const nextFirstName = normalizeNullableText(first_name) ?? normalizeNullableText(existingUser.first_name);
            const nextLastName = normalizeNullableText(last_name) ?? normalizeNullableText(existingUser.last_name);
            const nextFullName = [nextFirstName, nextLastName].filter(Boolean).join(" ").trim() || null;
            push("full_name", nextFullName);
        }

        if (fields.length === 0 && access_role === undefined) {
            return res.status(400).json({ ok: false, error: "empty patch", correlationId });
        }

        values.push(userId, companyId, perimeterId);

        if (access_role !== undefined) {
            if (!["user", "admin", "admin_user"].includes(access_role)) {
                return res.status(400).json({ ok: false, error: "invalid access_role", correlationId });
            }
            await pool.query(
                `
                update perimeter_memberships
                set access_role = $1
                where user_id = $2
                  and company_id = $3
                  and perimeter_id = $4
                `,
                [access_role, userId, companyId, perimeterId]
            );
        }

        const { rows } = fields.length > 0 ? await pool.query(
            `
      update users
      set ${fields.join(", ")}
      where id = $${i}
        and company_id = $${i + 1}
        and coalesce(perimeter_id, home_perimeter_id) = $${i + 2}
      returning id, first_name, last_name, full_name, email, availability_status, location_id, fixed_location, role_id, department_id, company_id, perimeter_id
      `,
            values
        ) : { rows: [] as any[] };

        const userFromDb = rows?.[0]
            ? rows[0]
            : (await pool.query(
                `
                select id, first_name, last_name, full_name, email, availability_status, location_id, fixed_location, role_id, department_id, company_id, perimeter_id
                from users
                where id = $1
                  and company_id = $2
                  and coalesce(perimeter_id, home_perimeter_id) = $3
                limit 1
                `,
                [userId, companyId, perimeterId]
            )).rows?.[0] ?? null;

        let membershipAccessRole = null;
        if (userFromDb) {
            const membershipRes = await pool.query(
                `
                select access_role
                from perimeter_memberships
                where user_id = $1
                  and company_id = $2
                  and perimeter_id = $3
                limit 1
                `,
                [userId, companyId, perimeterId]
            );
            membershipAccessRole = membershipRes.rows?.[0]?.access_role ?? null;
        }

        invalidateMapCache();
        return res.json({
            ok: true,
            user: userFromDb ? { ...userFromDb, access_role: membershipAccessRole } : null,
            correlationId,
        });
    } catch (e) {
        next(e);
    }
});

adminRouter.patch("/users/:id/access-role", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const userId = String(req.params.id ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        const accessRole = String(req.body?.access_role ?? "").trim();
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        if (!userId) {
            return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED", correlationId });
        }
        if (!["user", "admin", "admin_user"].includes(accessRole)) {
            return res.status(400).json({ ok: false, error: "invalid access_role", correlationId });
        }

        const membershipResult = await pool.query(
            `
            insert into perimeter_memberships (user_id, company_id, perimeter_id, access_role, status)
            values ($1, $2, $3, $4, 'active')
            on conflict (user_id, company_id, perimeter_id)
            do update set access_role = excluded.access_role
            returning user_id, company_id, perimeter_id, access_role
            `,
            [userId, companyId, perimeterId, accessRole]
        );

        return res.json({
            ok: true,
            membership: membershipResult.rows[0] ?? null,
            correlationId,
        });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/positions", async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const { rows } = await pool.query(`
      select
        p.id,
        p.title,
        p.occupied_by
      from positions p
      where p.company_id = $1
        and p.perimeter_id = $2
      order by p.title asc
      limit 1000
    `, [companyId, perimeterId]);
        return res.json({ ok: true, positions: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/locations", async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
      select id, name, latitude, longitude
      from locations
      order by name asc
      limit 2000
    `);

        return res.json({ ok: true, locations: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/roles", async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId ?? null;
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }

        const roleColumns = await pool.query<{ column_name: string }>(
            `
            select column_name
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'roles'
            `
        );
        const roleCols = new Set(roleColumns.rows.map((r) => r.column_name));
        const hasRoleTenantScope = roleCols.has("company_id") && roleCols.has("perimeter_id");

        const rolesRes = await pool.query(
            hasRoleTenantScope
                ? `
                  with scoped_roles as (
                    select r.id, r.name
                    from roles r
                    where (
                          r.company_id = $1
                      and r.perimeter_id = $2
                    )
                       or (
                          (r.company_id is null or r.perimeter_id is null)
                      and exists (
                            select 1
                            from users u_scope
                            where u_scope.role_id = r.id
                              and u_scope.company_id = $1
                              and coalesce(u_scope.perimeter_id, u_scope.home_perimeter_id) = $2
                          )
                       )
                  )
                  select
                    sr.id,
                    sr.name,
                    count(distinct u.id)::int as assigned_users_count
                  from scoped_roles sr
                  left join users u
                    on u.role_id = sr.id
                   and u.company_id = $1
                   and coalesce(u.perimeter_id, u.home_perimeter_id) = $2
                  group by sr.id, sr.name
                  order by sr.name asc
                  `
                : `
                  with scoped_roles as (
                    select distinct r.id, r.name
                    from roles r
                    join users u_scope on u_scope.role_id = r.id
                    where u_scope.company_id = $1
                      and coalesce(u_scope.perimeter_id, u_scope.home_perimeter_id) = $2
                  )
                  select
                    sr.id,
                    sr.name,
                    count(distinct u.id)::int as assigned_users_count
                  from scoped_roles sr
                  left join users u
                    on u.role_id = sr.id
                   and u.company_id = $1
                   and coalesce(u.perimeter_id, u.home_perimeter_id) = $2
                  group by sr.id, sr.name
                  order by sr.name asc
                  `,
            [companyId, perimeterId]
        );

        const compatRes = await pool.query(
            hasRoleTenantScope
                ? `
                  with scoped_roles as (
                    select r.id
                    from roles r
                    where (
                          r.company_id = $1
                      and r.perimeter_id = $2
                    )
                       or (
                          (r.company_id is null or r.perimeter_id is null)
                      and exists (
                            select 1
                            from users u_scope
                            where u_scope.role_id = r.id
                              and u_scope.company_id = $1
                              and coalesce(u_scope.perimeter_id, u_scope.home_perimeter_id) = $2
                          )
                       )
                  )
                  select
                    rc.role_id,
                    rc.compatible_role_id,
                    cr.name as compatible_role_name
                  from role_compatibilities rc
                  join roles cr on cr.id = rc.compatible_role_id
                  join scoped_roles left_role on left_role.id = rc.role_id
                  join scoped_roles right_role on right_role.id = rc.compatible_role_id
                  order by cr.name asc
                  `
                : `
                  with scoped_roles as (
                    select distinct r.id
                    from roles r
                    join users u_scope on u_scope.role_id = r.id
                    where u_scope.company_id = $1
                      and coalesce(u_scope.perimeter_id, u_scope.home_perimeter_id) = $2
                  )
                  select
                    rc.role_id,
                    rc.compatible_role_id,
                    cr.name as compatible_role_name
                  from role_compatibilities rc
                  join roles cr on cr.id = rc.compatible_role_id
                  join scoped_roles left_role on left_role.id = rc.role_id
                  join scoped_roles right_role on right_role.id = rc.compatible_role_id
                  order by cr.name asc
                  `,
            [companyId, perimeterId]
        );

        const compatByRoleId = new Map<string, Array<{ compatible_role_id: string; compatible_role_name: string }>>();
        for (const row of compatRes.rows) {
            const roleId = String(row.role_id);
            if (!compatByRoleId.has(roleId)) compatByRoleId.set(roleId, []);
            compatByRoleId.get(roleId)!.push({
                compatible_role_id: String(row.compatible_role_id),
                compatible_role_name: String(row.compatible_role_name ?? ""),
            });
        }

        const roles = rolesRes.rows.map((row: any) => ({
            id: String(row.id),
            name: String(row.name),
            assigned_users_count: Number(row.assigned_users_count ?? 0),
            compatibilities: compatByRoleId.get(String(row.id)) ?? [],
        }));

        return res.json({ ok: true, roles, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.post("/roles", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId ?? null;
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }

        const name = String(req.body?.name ?? "").trim();
        if (!name) return res.status(400).json({ ok: false, error: "missing name", correlationId });

        const { rows } = await pool.query(
            `
            insert into roles (name, company_id, perimeter_id)
            values ($1, $2, $3)
            returning id, name, company_id, perimeter_id
            `,
            [name, companyId, perimeterId]
        );

        invalidateMapCache();
        await audit("role_create", r.user.id, { name, companyId, perimeterId }, { role: rows[0] ?? null }, correlationId);
        return res.status(201).json({ ok: true, role: rows[0] ?? null, correlationId });
    } catch (e: any) {
        if (String(e?.code ?? "") === "23505") {
            return res.status(409).json({
                ok: false,
                error: "ROLE_ALREADY_EXISTS",
                message: "Esiste già un ruolo con questo nome nel perimetro corrente.",
                correlationId: (req as any).correlationId ?? null,
            });
        }
        next(e);
    }
});

adminRouter.put("/roles/:id", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId ?? null;
        const roleId = String(req.params.id ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        const name = String(req.body?.name ?? "").trim();
        if (!name) return res.status(400).json({ ok: false, error: "missing name", correlationId });

        const { rows } = await pool.query(
            `
            update roles r
            set name = $2,
                company_id = coalesce(r.company_id, $3),
                perimeter_id = coalesce(r.perimeter_id, $4)
            where r.id = $1
              and (
                    (r.company_id = $3 and r.perimeter_id = $4)
                 or (
                      (r.company_id is null or r.perimeter_id is null)
                  and not exists (
                        select 1
                        from users ux
                        where ux.role_id = r.id
                          and (
                                ux.company_id <> $3
                             or coalesce(ux.perimeter_id, ux.home_perimeter_id) <> $4
                          )
                    )
                 )
              )
            returning id, name, company_id, perimeter_id
            `,
            [roleId, name, companyId, perimeterId]
        );
        if (!rows[0]) {
            return res.status(404).json({
                ok: false,
                error: "ROLE_NOT_FOUND",
                message: "Ruolo non trovato nel perimetro corrente.",
                correlationId,
            });
        }

        invalidateMapCache();
        await audit("role_update", r.user.id, { roleId, name, companyId, perimeterId }, { role: rows[0] }, correlationId);
        return res.json({ ok: true, role: rows[0], correlationId });
    } catch (e: any) {
        if (String(e?.code ?? "") === "23505") {
            return res.status(409).json({
                ok: false,
                error: "ROLE_ALREADY_EXISTS",
                message: "Esiste già un ruolo con questo nome nel perimetro corrente.",
                correlationId: (req as any).correlationId ?? null,
            });
        }
        next(e);
    }
});

adminRouter.delete("/roles/:id", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId ?? null;
        const roleId = String(req.params.id ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }

        const roleRes = await pool.query(
            `
            select
              r.id,
              r.name,
              count(u.id)::int as users_count
            from roles r
            left join users u on u.role_id = r.id
            where r.id = $1
              and (
                    (r.company_id = $2 and r.perimeter_id = $3)
                 or (
                      (r.company_id is null or r.perimeter_id is null)
                  and not exists (
                        select 1
                        from users ux
                        where ux.role_id = r.id
                          and (
                                ux.company_id <> $2
                             or coalesce(ux.perimeter_id, ux.home_perimeter_id) <> $3
                          )
                    )
                 )
              )
            group by r.id, r.name
            `,
            [roleId, companyId, perimeterId]
        );

        const roleRow = roleRes.rows[0] ?? null;
        if (!roleRow) {
            return res.status(404).json({
                ok: false,
                error: "ROLE_NOT_FOUND",
                message: "Ruolo non trovato nel perimetro corrente.",
                correlationId,
            });
        }

        const usersCount = Number(roleRow.users_count ?? 0);
        if (usersCount > 0) {
            return res.status(409).json({
                ok: false,
                error: "ROLE_HAS_USERS",
                message: "Impossibile eliminare il ruolo: ci sono utenti assegnati.",
                users_count: usersCount,
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            await client.query(
                `delete from role_compatibilities where role_id = $1 or compatible_role_id = $1`,
                [roleId]
            );
            const del = await client.query(
                `
                delete from roles r
                where r.id = $1
                  and (
                        (r.company_id = $2 and r.perimeter_id = $3)
                     or (
                          (r.company_id is null or r.perimeter_id is null)
                      and not exists (
                            select 1
                            from users ux
                            where ux.role_id = r.id
                              and (
                                    ux.company_id <> $2
                                 or coalesce(ux.perimeter_id, ux.home_perimeter_id) <> $3
                              )
                        )
                     )
                  )
                `,
                [roleId, companyId, perimeterId]
            );
            return { deleted: del.rowCount ?? 0 };
        });

        if ((out.deleted ?? 0) === 0) {
            return res.status(404).json({
                ok: false,
                error: "ROLE_NOT_FOUND",
                message: "Ruolo non trovato nel perimetro corrente.",
                correlationId,
            });
        }

        invalidateMapCache();
        await audit("role_delete", r.user.id, { roleId, companyId, perimeterId }, out, correlationId);
        return res.json({ ok: true, ...out, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.post("/roles/:id/compatibility", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId ?? null;
        const roleId = String(req.params.id ?? "").trim();
        const targetId = String(req.body?.targetRoleId ?? req.body?.target_id ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        if (!targetId) return res.status(400).json({ ok: false, error: "missing targetRoleId", correlationId });
        if (roleId === targetId) {
            return res.status(400).json({ ok: false, error: "ROLE_COMPATIBILITY_SELF_NOT_ALLOWED", correlationId });
        }

        const scopedRoles = await pool.query(
            `
            with selected as (
              select r.id
              from roles r
              where r.id = any($1::uuid[])
                and (
                      (r.company_id = $2 and r.perimeter_id = $3)
                   or (
                        (r.company_id is null or r.perimeter_id is null)
                    and not exists (
                          select 1
                          from users ux
                          where ux.role_id = r.id
                            and (
                                  ux.company_id <> $2
                               or coalesce(ux.perimeter_id, ux.home_perimeter_id) <> $3
                            )
                      )
                   )
                )
            )
            select id from selected
            `,
            [[roleId, targetId], companyId, perimeterId]
        );
        const foundIds = new Set(scopedRoles.rows.map((row: { id: string }) => row.id));
        if (!foundIds.has(roleId) || !foundIds.has(targetId)) {
            return res.status(404).json({
                ok: false,
                error: "ROLE_NOT_FOUND",
                message: "Entrambi i ruoli devono appartenere al perimetro corrente.",
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            const insertDirect = await client.query(
                `
                insert into role_compatibilities (role_id, compatible_role_id)
                select $1, $2
                where not exists (
                  select 1
                  from role_compatibilities
                  where role_id = $1 and compatible_role_id = $2
                )
                `,
                [roleId, targetId]
            );
            const insertReverse = await client.query(
                `
                insert into role_compatibilities (role_id, compatible_role_id)
                select $1, $2
                where not exists (
                  select 1
                  from role_compatibilities
                  where role_id = $1 and compatible_role_id = $2
                )
                `,
                [targetId, roleId]
            );
            return {
                created: (insertDirect.rowCount ?? 0) + (insertReverse.rowCount ?? 0),
            };
        });

        await audit(
            "role_compatibility_add",
            r.user.id,
            { roleId, targetId, companyId, perimeterId },
            out,
            correlationId
        );
        return res.status(201).json({ ok: true, ...out, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.delete("/roles/:id/compatibility/:targetId", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId ?? null;
        const roleId = String(req.params.id ?? "").trim();
        const targetId = String(req.params.targetId ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        if (!targetId) return res.status(400).json({ ok: false, error: "missing targetId", correlationId });

        const out = await withTx(async (client) => {
            const delDirect = await client.query(
                `delete from role_compatibilities where role_id = $1 and compatible_role_id = $2`,
                [roleId, targetId]
            );
            const delReverse = await client.query(
                `delete from role_compatibilities where role_id = $1 and compatible_role_id = $2`,
                [targetId, roleId]
            );
            return {
                removed: (delDirect.rowCount ?? 0) + (delReverse.rowCount ?? 0),
            };
        });

        await audit(
            "role_compatibility_remove",
            r.user.id,
            { roleId, targetId, companyId, perimeterId },
            out,
            correlationId
        );
        return res.json({ ok: true, ...out, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/departments", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        const { rows } = await pool.query(
            `
            select
              d.id,
              d.name,
              count(u.id)::int as assigned_users_count
            from departments d
            left join users u
              on u.department_id = d.id
             and u.company_id = $1
             and coalesce(u.perimeter_id, u.home_perimeter_id) = $2
            where d.company_id = $1
              and d.perimeter_id = $2
            group by d.id, d.name
            order by d.name asc
            `,
            [companyId, perimeterId]
        );

        return res.json({ ok: true, departments: rows, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.post("/departments", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        const name = String(req.body?.name ?? "").trim();
        if (!name) {
            return res.status(400).json({ ok: false, error: "missing name", correlationId });
        }
        const { rows } = await pool.query(
            `
            insert into departments (company_id, perimeter_id, name)
            values ($1, $2, $3)
            returning id, name
            `,
            [companyId, perimeterId, name]
        );
        return res.status(201).json({ ok: true, department: rows[0] ?? null, correlationId });
    } catch (e: any) {
        if (String(e?.code ?? "") === "23505") {
            return res.status(409).json({
                ok: false,
                error: "DEPARTMENT_ALREADY_EXISTS",
                message: "Esiste già un reparto con questo nome.",
                correlationId: (req as any).correlationId ?? null,
            });
        }
        next(e);
    }
});

adminRouter.patch("/departments/:id", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const departmentId = String(req.params.id ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        const name = String(req.body?.name ?? "").trim();
        if (!name) {
            return res.status(400).json({ ok: false, error: "missing name", correlationId });
        }
        const { rows } = await pool.query(
            `
            update departments
            set name = $1
            where id = $2
              and company_id = $3
              and perimeter_id = $4
            returning id, name
            `,
            [name, departmentId, companyId, perimeterId]
        );
        if (!rows[0]) {
            return res.status(404).json({ ok: false, error: "DEPARTMENT_NOT_FOUND", correlationId });
        }
        return res.json({ ok: true, department: rows[0], correlationId });
    } catch (e: any) {
        if (String(e?.code ?? "") === "23505") {
            return res.status(409).json({
                ok: false,
                error: "DEPARTMENT_ALREADY_EXISTS",
                message: "Esiste già un reparto con questo nome.",
                correlationId: (req as any).correlationId ?? null,
            });
        }
        next(e);
    }
});

adminRouter.delete("/departments/:id", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const departmentId = String(req.params.id ?? "").trim();
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        const assignedUsers = await pool.query(
            `
            select count(*)::int as users_count
            from users
            where department_id = $1
              and company_id = $2
              and coalesce(perimeter_id, home_perimeter_id) = $3
            `,
            [departmentId, companyId, perimeterId]
        );
        const usersCount = Number(assignedUsers.rows[0]?.users_count ?? 0);
        if (usersCount > 0) {
            return res.status(409).json({
                ok: false,
                error: "DEPARTMENT_HAS_USERS",
                message: "Impossibile eliminare: ci sono utenti assegnati a questo reparto.",
                correlationId,
            });
        }

        const del = await pool.query(
            `
            delete from departments
            where id = $1
              and company_id = $2
              and perimeter_id = $3
            `,
            [departmentId, companyId, perimeterId]
        );
        if ((del.rowCount ?? 0) === 0) {
            return res.status(404).json({ ok: false, error: "DEPARTMENT_NOT_FOUND", correlationId });
        }
        return res.json({ ok: true, deleted: del.rowCount ?? 0, correlationId });
    } catch (e) {
        next(e);
    }
});

type ManagerEntityConfig = {
    resourcePath: "/responsabili" | "/hr-managers";
    managerTable: "responsabili" | "hr_managers";
    assignmentTable: "user_responsabile_assignments" | "user_hr_assignments";
    managerIdColumn: "responsabile_id" | "hr_manager_id";
    listProperty: "responsabili" | "hr_managers";
};

function registerManagerEntityRoutes(config: ManagerEntityConfig) {
    const { resourcePath, managerTable, assignmentTable, managerIdColumn, listProperty } = config;

    adminRouter.get(resourcePath, requireOperationalPerimeterAdmin, async (req, res, next) => {
        try {
            const correlationId = (req as any).correlationId;
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }
            const { rows } = await pool.query(
                `
                select
                  m.id,
                  m.name,
                  m.email,
                  count(distinct a.user_id)::int as assigned_users_count
                from ${managerTable} m
                left join ${assignmentTable} a
                  on a.${managerIdColumn} = m.id
                 and a.company_id = $1
                 and a.perimeter_id = $2
                where m.company_id = $1
                  and m.perimeter_id = $2
                group by m.id, m.name, m.email
                order by m.name asc
                `,
                [companyId, perimeterId]
            );
            return res.json({ ok: true, [listProperty]: rows, correlationId });
        } catch (e) {
            next(e);
        }
    });

    adminRouter.post(resourcePath, requireOperationalPerimeterAdmin, async (req, res, next) => {
        try {
            const correlationId = (req as any).correlationId;
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }
            const name = String(req.body?.name ?? "").trim();
            const email = normalizeEmailInput(req.body?.email);
            if (!name) {
                return res.status(400).json({ ok: false, error: "missing name", correlationId });
            }
            if (email && !isValidEmailFormat(email)) {
                return res.status(400).json({ ok: false, error: "invalid email format", correlationId });
            }

            const { rows } = await pool.query(
                `
                insert into ${managerTable} (company_id, perimeter_id, name, email)
                values ($1, $2, $3, $4)
                returning id, name, email
                `,
                [companyId, perimeterId, name, email]
            );
            return res.status(201).json({ ok: true, manager: rows[0] ?? null, correlationId });
        } catch (e) {
            next(e);
        }
    });

    adminRouter.patch(`${resourcePath}/:id`, requireOperationalPerimeterAdmin, async (req, res, next) => {
        try {
            const correlationId = (req as any).correlationId;
            const managerId = String(req.params.id ?? "").trim();
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }
            const name = String(req.body?.name ?? "").trim();
            const email = normalizeEmailInput(req.body?.email);
            if (!name) {
                return res.status(400).json({ ok: false, error: "missing name", correlationId });
            }
            if (email && !isValidEmailFormat(email)) {
                return res.status(400).json({ ok: false, error: "invalid email format", correlationId });
            }

            const { rows } = await pool.query(
                `
                update ${managerTable}
                set name = $1,
                    email = $2
                where id = $3
                  and company_id = $4
                  and perimeter_id = $5
                returning id, name, email
                `,
                [name, email, managerId, companyId, perimeterId]
            );
            if (!rows[0]) {
                return res.status(404).json({ ok: false, error: "MANAGER_NOT_FOUND", correlationId });
            }
            return res.json({ ok: true, manager: rows[0], correlationId });
        } catch (e) {
            next(e);
        }
    });

    adminRouter.delete(`${resourcePath}/:id`, requireOperationalPerimeterAdmin, async (req, res, next) => {
        try {
            const correlationId = (req as any).correlationId;
            const managerId = String(req.params.id ?? "").trim();
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }
            const del = await pool.query(
                `
                delete from ${managerTable}
                where id = $1
                  and company_id = $2
                  and perimeter_id = $3
                `,
                [managerId, companyId, perimeterId]
            );
            if ((del.rowCount ?? 0) === 0) {
                return res.status(404).json({ ok: false, error: "MANAGER_NOT_FOUND", correlationId });
            }
            return res.json({ ok: true, deleted: del.rowCount ?? 0, correlationId });
        } catch (e) {
            next(e);
        }
    });

    adminRouter.get(`${resourcePath}/:id/users`, requireOperationalPerimeterAdmin, async (req, res, next) => {
        try {
            const correlationId = (req as any).correlationId;
            const managerId = String(req.params.id ?? "").trim();
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }

            const { rows } = await pool.query(
                `
                select
                  u.id,
                  u.first_name,
                  u.last_name,
                  u.full_name,
                  u.email,
                  u.role_id,
                  r.name as role_name,
                  u.department_id,
                  dpt.name as department_name,
                  u.location_id,
                  l.name as location_name
                from ${assignmentTable} a
                join users u on u.id = a.user_id
                left join roles r on r.id = u.role_id
                left join departments dpt on dpt.id = u.department_id
                left join locations l on l.id = u.location_id
                where a.${managerIdColumn} = $1
                  and a.company_id = $2
                  and a.perimeter_id = $3
                  and u.company_id = $2
                  and coalesce(u.perimeter_id, u.home_perimeter_id) = $3
                order by u.last_name nulls last, u.first_name nulls last, u.full_name nulls last, u.id
                `,
                [managerId, companyId, perimeterId]
            );

            return res.json({ ok: true, users: rows, correlationId });
        } catch (e) {
            next(e);
        }
    });

    adminRouter.post(`${resourcePath}/:id/assign`, requireOperationalPerimeterAdmin, async (req, res, next) => {
        try {
            const correlationId = (req as any).correlationId;
            const managerId = String(req.params.id ?? "").trim();
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }
            const rawUserIds: unknown[] = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
            const userIds: string[] = Array.from(new Set(
                rawUserIds
                    .map((value: unknown) => String(value ?? "").trim())
                    .filter(Boolean)
            ));

            if (userIds.length === 0) {
                return res.status(400).json({ ok: false, error: "user_ids required", correlationId });
            }

            const managerExists = await pool.query(
                `
                select id
                from ${managerTable}
                where id = $1
                  and company_id = $2
                  and perimeter_id = $3
                limit 1
                `,
                [managerId, companyId, perimeterId]
            );
            if (!managerExists.rows[0]) {
                return res.status(404).json({ ok: false, error: "MANAGER_NOT_FOUND", correlationId });
            }

            const scopedUsers = await pool.query(
                `
                select id
                from users
                where id = any($1::uuid[])
                  and company_id = $2
                  and coalesce(perimeter_id, home_perimeter_id) = $3
                `,
                [userIds, companyId, perimeterId]
            );
            const scopedUserIds = new Set(scopedUsers.rows.map((row: { id: string }) => row.id));
            const invalidUserIds = userIds.filter((id) => !scopedUserIds.has(id));
            if (invalidUserIds.length > 0) {
                return res.status(400).json({
                    ok: false,
                    error: "INVALID_USER_SCOPE",
                    message: "Alcuni utenti non appartengono al perimetro corrente.",
                    invalid_user_ids: invalidUserIds,
                    correlationId,
                });
            }

            const out = await pool.query(
                `
                insert into ${assignmentTable} (user_id, ${managerIdColumn}, company_id, perimeter_id)
                select user_id, $2, $3, $4
                from unnest($1::uuid[]) as user_id
                on conflict (user_id, ${managerIdColumn}) do nothing
                `,
                [userIds, managerId, companyId, perimeterId]
            );

            return res.json({
                ok: true,
                assigned: out.rowCount ?? 0,
                correlationId,
            });
        } catch (e) {
            next(e);
        }
    });

    adminRouter.delete(`${resourcePath}/:id/assign/:userId`, requireOperationalPerimeterAdmin, async (req, res, next) => {
        try {
            const correlationId = (req as any).correlationId;
            const managerId = String(req.params.id ?? "").trim();
            const userId = String(req.params.userId ?? "").trim();
            const { companyId, perimeterId } = getTenantScope(req);
            if (!companyId || !perimeterId) {
                return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
            }

            const del = await pool.query(
                `
                delete from ${assignmentTable}
                where ${managerIdColumn} = $1
                  and user_id = $2
                  and company_id = $3
                  and perimeter_id = $4
                `,
                [managerId, userId, companyId, perimeterId]
            );

            return res.json({
                ok: true,
                removed: del.rowCount ?? 0,
                correlationId,
            });
        } catch (e) {
            next(e);
        }
    });
}

registerManagerEntityRoutes({
    resourcePath: "/responsabili",
    managerTable: "responsabili",
    assignmentTable: "user_responsabile_assignments",
    managerIdColumn: "responsabile_id",
    listProperty: "responsabili",
});

registerManagerEntityRoutes({
    resourcePath: "/hr-managers",
    managerTable: "hr_managers",
    assignmentTable: "user_hr_assignments",
    managerIdColumn: "hr_manager_id",
    listProperty: "hr_managers",
});

adminRouter.get("/test-scenarios", async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const { rows } = await pool.query(`
      select id, name
      from test_scenarios
      where company_id = $1
        and perimeter_id = $2
      order by created_at asc
      limit 500
    `, [companyId, perimeterId]);
        return res.json({ ok: true, scenarios: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

/**
 * GET /api/admin/test-scenarios/:id/applications
 */
adminRouter.get("/test-scenarios/:id/applications", async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const scenarioId = req.params.id;
        const { companyId, perimeterId } = getTenantScope(req);

        const { rows } = await pool.query(
            `
      select
        id,
        user_id,
        position_id,
        priority
      from test_scenario_applications
      where scenario_id = $1
        and company_id = $2
        and perimeter_id = $3
      order by priority asc, created_at asc nulls last, id asc
      `,
            [scenarioId, companyId, perimeterId]
        );

        return res.json({ ok: true, applications: rows, correlationId });
    } catch (e) {
        next(e);
    }
});

/**
 * PATCH /api/admin/test-scenarios/:id
 */
adminRouter.patch("/test-scenarios/:id", async (req: Request, res: Response, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId;
        const scenarioId = req.params.id;
        const { companyId, perimeterId } = getTenantScope(req);

        const name = String((req as any).body?.name ?? "").trim();
        if (!name) {
            return res.status(400).json({ ok: false, error: "missing name", correlationId });
        }

        const { rows } = await pool.query(
            `
      update test_scenarios
      set name = $1
      where id = $2
        and company_id = $3
        and perimeter_id = $4
      returning id, name
      `,
            [name, scenarioId, companyId, perimeterId]
        );

        const scenario = rows?.[0] ?? null;

        await audit("scenario_rename", r.user.id, { scenarioId }, { scenario }, correlationId);

        return res.json({ ok: true, scenario, correlationId });
    } catch (e) {
        next(e);
    }
});

/**
 * DELETE /api/admin/test-scenarios/:id
 */
adminRouter.delete("/test-scenarios/:id", async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    const scenarioId = req.params.id;
    const { companyId, perimeterId } = getTenantScope(req);

    try {
        const out = await withTx(async (client) => {
            const delApps = await client.query(
                `delete from test_scenario_applications where scenario_id = $1 and company_id = $2 and perimeter_id = $3`,
                [scenarioId, companyId, perimeterId]
            );
            const delScenario = await client.query(
                `delete from test_scenarios where id = $1 and company_id = $2 and perimeter_id = $3`,
                [scenarioId, companyId, perimeterId]
            );

            return {
                scenarioId,
                applicationsDeleted: delApps.rowCount ?? 0,
                scenariosDeleted: delScenario.rowCount ?? 0,
            };
        });

        await audit("scenario_delete", r.user.id, { scenarioId }, out, correlationId);

        return res.json({ ok: true, out, correlationId });
    } catch (e: any) {
        await audit(
            "scenario_delete",
            r.user.id,
            { scenarioId },
            { error: String(e?.message ?? e) },
            correlationId
        );

        return res.status(500).json({ ok: false, error: "Delete scenario failed", correlationId });
    }
});

/**
 * DELETE /api/admin/test-scenarios/:id/applications/:appId
 */
adminRouter.delete("/test-scenarios/:id/applications/:appId", async (req, res, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId;

        const scenarioId = req.params.id;
        const appId = req.params.appId;
        const { companyId, perimeterId } = getTenantScope(req);

        const del = await pool.query(
            `
      delete from test_scenario_applications
      where id = $1 and scenario_id = $2
        and company_id = $3
        and perimeter_id = $4
      `,
            [appId, scenarioId, companyId, perimeterId]
        );

        const out = { scenarioId, appId, deleted: del.rowCount ?? 0 };
        await audit("scenario_application_delete", r.user.id, { scenarioId, appId }, out, correlationId);

        return res.json({ ok: true, out, correlationId });
    } catch (e) {
        next(e);
    }
});

/**
 * DELETE /api/admin/test-scenarios/:id/applications
 */
adminRouter.delete("/test-scenarios/:id/applications", async (req: Request, res: Response, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const correlationId = (req as any).correlationId;

        const scenarioId = req.params.id;
        const { companyId, perimeterId } = getTenantScope(req);

        const del = await pool.query(
            `delete from test_scenario_applications where scenario_id = $1 and company_id = $2 and perimeter_id = $3`,
            [scenarioId, companyId, perimeterId]
        );

        const out = { scenarioId, deleted: del.rowCount ?? 0 };
        await audit("scenario_applications_delete_all", r.user.id, { scenarioId }, out, correlationId);

        return res.json({ ok: true, out, correlationId });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/config", async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const { rows } = await pool.query(`
      select max_applications
      from app_config
      where singleton = true
        and company_id = $1
        and perimeter_id = $2
      limit 1
    `, [companyId, perimeterId]);
        return res.json({
            ok: true,
            config: rows?.[0] ?? null,
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});

adminRouter.post("/locations", async (req, res, next) => {
    try {
        const { name, latitude, longitude } = req.body ?? {};
        if (!name) return res.status(400).json({ ok: false, error: "missing name" });

        const { rows } = await pool.query(
            `insert into locations (name, latitude, longitude)
       values ($1, $2, $3)
       returning id, name, latitude, longitude`,
            [String(name), latitude ?? null, longitude ?? null]
        );

        invalidateMapCache();
        return res.status(201).json({ ok: true, location: rows[0], correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

adminRouter.delete("/locations/:id", async (req, res, next) => {
    try {
        const id = req.params.id;
        const del = await pool.query(`delete from locations where id = $1`, [id]);
        invalidateMapCache();
        return res.json({ ok: true, deleted: del.rowCount ?? 0, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

/**
 * POST /api/admin/test-scenarios
 */
adminRouter.post("/test-scenarios", async (req: Request, res: Response, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const { companyId, perimeterId } = getTenantScope(req);

        const correlationId = (req as any).correlationId;
        const name = String((req as any).body?.name ?? "").trim();
        if (!name) return res.status(400).json({ ok: false, error: "missing name", correlationId });

        const { rows } = await pool.query(
            `
            insert into test_scenarios (name, company_id, perimeter_id)
            values ($1, $2, $3)
            returning id, name
            `,
            [name, companyId, perimeterId]
        );

        const scenario = rows[0];
        await audit("scenario_create", r.user.id, { name }, { scenario }, correlationId);

        return res.status(201).json({ ok: true, scenario, correlationId });
    } catch (e) {
        next(e);
    }
});

/**
 * POST /api/admin/test-scenarios/:id/applications
 */
adminRouter.post("/test-scenarios/:id/applications", async (req: Request, res: Response, next) => {
    try {
        const r = req as unknown as AuthedRequest;
        const { companyId, perimeterId } = getTenantScope(req);

        const correlationId = (req as any).correlationId;
        const scenarioId = req.params.id;

        const user_id = String((req as any).body?.user_id ?? "");
        const position_id = String((req as any).body?.position_id ?? "");
        const priority = Number((req as any).body?.priority ?? 1);

        if (!user_id || !position_id || !Number.isFinite(priority) || priority < 1) {
            return res.status(400).json({ ok: false, error: "invalid body", correlationId });
        }

        const { rows } = await pool.query(
            `
      insert into test_scenario_applications (scenario_id, user_id, position_id, priority, company_id, perimeter_id)
      values ($1, $2, $3, $4, $5, $6)
      returning id, scenario_id, user_id, position_id, priority
      `,
            [scenarioId, user_id, position_id, priority, companyId, perimeterId]
        );

        const application = rows[0];
        await audit("scenario_application_create", r.user.id, { scenarioId }, { application }, correlationId);

        return res.status(201).json({ ok: true, application, correlationId });
    } catch (e) {
        next(e);
    }
});

/* =========================================================
   INTERLOCKING SCENARIOS
   ========================================================= */

/**
 * GET /api/admin/interlocking-scenarios
 */
adminRouter.get("/interlocking-scenarios", requireOperationalPerimeterAdmin, async (req: Request, res: Response, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);
        const campaignId = String((req.query as any)?.campaign_id ?? "").trim();
        if (!campaignId) {
            return res.status(400).json({
                ok: false,
                error: { code: "CAMPAIGN_ID_REQUIRED", message: "campaign_id is required" },
                correlationId,
            });
        }

        const campaignRes = await pool.query(
            `
            select id
            from campaigns
            where id = $1
              and company_id = $2
              and perimeter_id = $3
              and status = 'campaign_closed'
            limit 1
            `,
            [campaignId, companyId, perimeterId]
        );
        if (!campaignRes.rows[0]) {
            return res.status(404).json({
                ok: false,
                error: {
                    code: "CAMPAIGN_NOT_FOUND_OR_NOT_CLOSED",
                    message: "Campaign not found in scope or not closed",
                },
                correlationId,
            });
        }

        const { rows } = await pool.query(
            `
            select
              id,
              campaign_id,
              scenario_code,
              generated_at,
              strategy,
              max_len,
              total_chains,
              unique_people,
              coverage,
              avg_length,
              max_length,
              avg_priority,
              build_nodes,
              build_relationships,
              chains_json,
              optimal_chains_json,
              created_at
            from interlocking_scenarios
            where company_id = $1
              and perimeter_id = $2
              and campaign_id = $3
            order by generated_at desc, created_at desc
            limit 500
            `
            ,
            [companyId, perimeterId, campaignId]
        );

        return res.json({
            ok: true,
            scenarios: rows,
            correlationId,
        });
    } catch (e) {
        next(e);
    }
});

adminRouter.get("/interlocking-scenarios/export.csv", requireOperationalPerimeterAdmin, async (req: Request, res: Response, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);
        const campaignId = String((req.query as any)?.campaign_id ?? "").trim();
        if (!campaignId) {
            return res.status(400).json({
                ok: false,
                error: { code: "CAMPAIGN_ID_REQUIRED", message: "campaign_id is required" },
                correlationId,
            });
        }

        const campaignRes = await pool.query(
            `
            select id
            from campaigns
            where id = $1
              and company_id = $2
              and perimeter_id = $3
              and status = 'campaign_closed'
            limit 1
            `,
            [campaignId, companyId, perimeterId]
        );
        if (!campaignRes.rows[0]) {
            return res.status(404).json({
                ok: false,
                error: {
                    code: "CAMPAIGN_NOT_FOUND_OR_NOT_CLOSED",
                    message: "Campaign not found in scope or not closed",
                },
                correlationId,
            });
        }

        const { rows } = await pool.query(
            `
            select
              campaign_id,
              scenario_code,
              generated_at,
              strategy,
              max_len,
              total_chains,
              unique_people,
              coverage,
              avg_length,
              max_length,
              avg_priority,
              build_nodes,
              build_relationships,
              created_at
            from interlocking_scenarios
            where company_id = $1
              and perimeter_id = $2
              and campaign_id = $3
            order by generated_at desc, created_at desc
            limit 5000
            `,
            [companyId, perimeterId, campaignId]
        );

        const headers = [
            "campaign_id",
            "scenario_code",
            "generated_at",
            "strategy",
            "max_len",
            "total_chains",
            "unique_people",
            "coverage",
            "avg_length",
            "max_length",
            "avg_priority",
            "build_nodes",
            "build_relationships",
            "created_at",
        ];

        const esc = (value: unknown) => {
            const raw = value == null ? "" : String(value);
            return `"${raw.replace(/"/g, "\"\"")}"`;
        };

        const lines = [
            headers.join(","),
            ...rows.map((row) => headers.map((h) => esc((row as any)[h])).join(",")),
        ];

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="interlocking-scenarios-${perimeterId}.csv"`
        );
        res.setHeader("x-correlation-id", correlationId ?? "");
        return res.status(200).send(lines.join("\n"));
    } catch (e) {
        next(e);
    }
});

/**
 * POST /api/admin/interlocking-scenarios
 */
adminRouter.post("/interlocking-scenarios", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    const { companyId, perimeterId } = getTenantScope(req);

    try {
        const {
            campaign_id,
            scenario_code,
            generated_at,
            strategy,
            max_len,
            total_chains,
            unique_people,
            coverage,
            avg_length,
            max_length,
            avg_priority,
            build_nodes,
            build_relationships,
            chains_json,
            optimal_chains_json,
        } = req.body ?? {};

        if (!campaign_id || !scenario_code || !generated_at || !strategy || !Number.isFinite(Number(max_len))) {
            return res.status(400).json({
                ok: false,
                error: { code: "INVALID_BODY", message: "Missing required interlocking scenario fields" },
                correlationId,
            });
        }

        const campaignId = String(campaign_id).trim();
        const campaignRes = await pool.query(
            `
            select id
            from campaigns
            where id = $1
              and company_id = $2
              and perimeter_id = $3
              and status = 'campaign_closed'
            limit 1
            `,
            [campaignId, companyId, perimeterId]
        );
        if (!campaignRes.rows[0]) {
            return res.status(400).json({
                ok: false,
                error: {
                    code: "CAMPAIGN_NOT_FOUND_OR_NOT_CLOSED",
                    message: "Campaign not found in scope or not closed",
                },
                correlationId,
            });
        }

        const { rows } = await pool.query(
            `
            insert into interlocking_scenarios (
              company_id,
              perimeter_id,
              campaign_id,
              scenario_code,
              generated_at,
              strategy,
              max_len,
              total_chains,
              unique_people,
              coverage,
              avg_length,
              max_length,
              avg_priority,
              build_nodes,
              build_relationships,
              chains_json,
              optimal_chains_json
            )
            values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb
            )
            returning
              id,
              campaign_id,
              scenario_code,
              generated_at,
              strategy,
              max_len,
              total_chains,
              unique_people,
              coverage,
              avg_length,
              max_length,
              avg_priority,
              build_nodes,
              build_relationships,
              chains_json,
              optimal_chains_json,
              created_at
            `,
            [
                companyId,
                perimeterId,
                campaignId,
                String(scenario_code),
                generated_at,
                String(strategy),
                Number(max_len),
                Number(total_chains ?? 0),
                Number(unique_people ?? 0),
                coverage ?? null,
                avg_length ?? null,
                max_length ?? null,
                avg_priority ?? null,
                build_nodes ?? null,
                build_relationships ?? null,
                JSON.stringify(Array.isArray(chains_json) ? chains_json : []),
                JSON.stringify(optimal_chains_json ?? null),
            ]
        );

        const scenario = rows?.[0] ?? null;

        await audit(
            "interlocking_scenario_create",
            r.user.id,
            {
                scenario_code: String(scenario_code),
                campaign_id: campaignId,
                company_id: companyId,
                perimeter_id: perimeterId,
            },
            { scenario },
            correlationId,
            { companyId, perimeterId }
        );

        return res.status(201).json({
            ok: true,
            scenario,
            correlationId,
        });
    } catch (e: any) {
        await audit(
            "interlocking_scenario_create",
            r.user.id,
            {
                body: req.body ?? {},
                company_id: companyId ?? null,
                perimeter_id: perimeterId ?? null,
            },
            { error: String(e?.message ?? e) },
            correlationId,
            { companyId, perimeterId }
        );

        return res.status(500).json({
            ok: false,
            error: {
                code: "INTERLOCKING_SCENARIO_CREATE_FAILED",
                message: String(e?.message ?? e),
            },
            correlationId,
        });
    }
});

/**
 * DELETE /api/admin/interlocking-scenarios
 * body: { ids: string[] }
 */
adminRouter.delete("/interlocking-scenarios", requireOperationalPerimeterAdmin, async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;
    const { companyId, perimeterId } = getTenantScope(req);

    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];

        if (ids.length === 0) {
            return res.status(400).json({
                ok: false,
                error: { code: "IDS_REQUIRED", message: "ids[] is required" },
                correlationId,
            });
        }

        const campaignId = String((req.query as any)?.campaign_id ?? req.body?.campaign_id ?? "").trim();
        let campaignFilterSql = "";
        const params: unknown[] = [ids, companyId, perimeterId];

        if (campaignId) {
            campaignFilterSql = " and campaign_id = $4";
            params.push(campaignId);
        }

        const del = await pool.query(
            `
            delete from interlocking_scenarios
            where id = any($1::uuid[])
              and company_id = $2
              and perimeter_id = $3
              ${campaignFilterSql}
            `,
            params
        );

        const out = {
            requested: ids.length,
            deleted: del.rowCount ?? 0,
        };

        await audit(
            "interlocking_scenario_delete_many",
            r.user.id,
            { ids, company_id: companyId, perimeter_id: perimeterId, campaign_id: campaignId || null },
            out,
            correlationId,
            { companyId, perimeterId }
        );

        return res.json({
            ok: true,
            out,
            correlationId,
        });
    } catch (e: any) {
        await audit(
            "interlocking_scenario_delete_many",
            r.user.id,
            {
                ids: req.body?.ids ?? null,
                company_id: companyId ?? null,
                perimeter_id: perimeterId ?? null,
            },
            { error: String(e?.message ?? e) },
            correlationId,
            { companyId, perimeterId }
        );

        return res.status(500).json({
            ok: false,
            error: {
                code: "INTERLOCKING_SCENARIO_DELETE_FAILED",
                message: String(e?.message ?? e),
            },
            correlationId,
        });
    }
});

/**
 * GET /api/admin/scenarios?campaign_id=...
 * Alias campaign-scoped for interlocking scenarios.
 */
adminRouter.get("/scenarios", requireOperationalPerimeterAdmin, async (req: Request, res: Response, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const campaignId = String((req.query as any)?.campaign_id ?? "").trim();
        if (!campaignId) {
            return res.status(400).json({
                ok: false,
                error: { code: "CAMPAIGN_ID_REQUIRED", message: "campaign_id is required" },
                correlationId,
            });
        }
        const { companyId, perimeterId } = getTenantScope(req);
        const campaignRes = await pool.query(
            `
            select id
            from campaigns
            where id = $1
              and company_id = $2
              and perimeter_id = $3
              and status = 'campaign_closed'
            limit 1
            `,
            [campaignId, companyId, perimeterId]
        );
        if (!campaignRes.rows[0]) {
            return res.status(404).json({
                ok: false,
                error: {
                    code: "CAMPAIGN_NOT_FOUND_OR_NOT_CLOSED",
                    message: "Campaign not found in scope or not closed",
                },
                correlationId,
            });
        }

        const { rows } = await pool.query(
            `
            select
              id,
              campaign_id,
              scenario_code,
              generated_at,
              strategy,
              max_len,
              total_chains,
              unique_people,
              coverage,
              avg_length,
              max_length,
              avg_priority,
              build_nodes,
              build_relationships,
              chains_json,
              optimal_chains_json,
              created_at
            from interlocking_scenarios
            where company_id = $1
              and perimeter_id = $2
              and campaign_id = $3
            order by generated_at desc, created_at desc
            limit 500
            `,
            [companyId, perimeterId, campaignId]
        );

        return res.json({ ok: true, scenarios: rows, correlationId });
    } catch (e) {
        next(e);
    }
});

/**
 * POST /api/admin/scenarios
 * Alias for creating campaign-scoped interlocking scenarios.
 */
adminRouter.post("/scenarios", requireOperationalPerimeterAdmin, async (req: Request, res: Response, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const r = req as unknown as AuthedRequest;
        const { companyId, perimeterId } = getTenantScope(req);
        const {
            campaign_id,
            scenario_code,
            generated_at,
            strategy,
            max_len,
            total_chains,
            unique_people,
            coverage,
            avg_length,
            max_length,
            avg_priority,
            build_nodes,
            build_relationships,
            chains_json,
            optimal_chains_json,
        } = req.body ?? {};

        if (!campaign_id || !scenario_code || !generated_at || !strategy || !Number.isFinite(Number(max_len))) {
            return res.status(400).json({
                ok: false,
                error: { code: "INVALID_BODY", message: "Missing required interlocking scenario fields" },
                correlationId,
            });
        }

        const campaignId = String(campaign_id).trim();
        const campaignRes = await pool.query(
            `
            select id
            from campaigns
            where id = $1
              and company_id = $2
              and perimeter_id = $3
              and status = 'campaign_closed'
            limit 1
            `,
            [campaignId, companyId, perimeterId]
        );
        if (!campaignRes.rows[0]) {
            return res.status(400).json({
                ok: false,
                error: {
                    code: "CAMPAIGN_NOT_FOUND_OR_NOT_CLOSED",
                    message: "Campaign not found in scope or not closed",
                },
                correlationId,
            });
        }

        const inserted = await pool.query(
            `
            insert into interlocking_scenarios (
              company_id,
              perimeter_id,
              campaign_id,
              scenario_code,
              generated_at,
              strategy,
              max_len,
              total_chains,
              unique_people,
              coverage,
              avg_length,
              max_length,
              avg_priority,
              build_nodes,
              build_relationships,
              chains_json,
              optimal_chains_json
            )
            values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb
            )
            returning
              id,
              campaign_id,
              scenario_code,
              generated_at,
              strategy,
              max_len,
              total_chains,
              unique_people,
              coverage,
              avg_length,
              max_length,
              avg_priority,
              build_nodes,
              build_relationships,
              chains_json,
              optimal_chains_json,
              created_at
            `,
            [
                companyId,
                perimeterId,
                campaignId,
                String(scenario_code),
                generated_at,
                String(strategy),
                Number(max_len),
                Number(total_chains ?? 0),
                Number(unique_people ?? 0),
                coverage ?? null,
                avg_length ?? null,
                max_length ?? null,
                avg_priority ?? null,
                build_nodes ?? null,
                build_relationships ?? null,
                JSON.stringify(Array.isArray(chains_json) ? chains_json : []),
                JSON.stringify(optimal_chains_json ?? null),
            ]
        );

        await audit(
            "interlocking_scenario_create",
            r.user.id,
            {
                scenario_code: String(scenario_code),
                campaign_id: campaignId,
                company_id: companyId,
                perimeter_id: perimeterId,
            },
            { scenario: inserted.rows?.[0] ?? null },
            correlationId,
            { companyId, perimeterId }
        );

        return res.status(201).json({ ok: true, scenario: inserted.rows?.[0] ?? null, correlationId });
    } catch (e) {
        next(e);
    }
});

/**
 * GET /api/admin/campaigns
 * Returns all campaigns for the current perimeter, sorted by created_at desc.
 */
adminRouter.get("/campaigns", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId: (req as any).correlationId });
        }
        const { rows } = await pool.query(
            `SELECT id, status, reservations_opened_at, reservations_closed_at,
                    campaign_opened_at, campaign_closed_at,
                    reserved_users_count, total_applications_count, created_at
             FROM campaigns
             WHERE company_id = $1 AND perimeter_id = $2
             ORDER BY created_at DESC
             LIMIT 100`,
            [companyId, perimeterId]
        );
        return res.json({ ok: true, campaigns: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

/**
 * GET /api/admin/campaigns/:campaignId
 * Returns one campaign (scoped to current perimeter) and its archived applications snapshot.
 */
adminRouter.get("/campaigns/:campaignId", requireOperationalPerimeterAdmin, async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const campaignId = String(req.params.campaignId ?? "");
        if (!companyId || !perimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId: (req as any).correlationId });
        }
        if (!campaignId) {
            return res.status(400).json({ ok: false, error: "CAMPAIGN_ID_REQUIRED", correlationId: (req as any).correlationId });
        }

        const campaignRes = await pool.query(
            `SELECT id, status, reservations_opened_at, reservations_closed_at,
                    campaign_opened_at, campaign_closed_at, reserved_users_count,
                    total_applications_count, created_at
             FROM campaigns
             WHERE id = $1 AND company_id = $2 AND perimeter_id = $3
             LIMIT 1`,
            [campaignId, companyId, perimeterId]
        );
        const campaign = campaignRes.rows[0] ?? null;
        if (!campaign) {
            return res.status(404).json({
                ok: false,
                error: "CAMPAIGN_NOT_FOUND",
                correlationId: (req as any).correlationId ?? null,
            });
        }

        const snapshotRes = await pool.query(
            `
            SELECT
              cas.id,
              cas.user_id,
              cas.position_id,
              p.title as position_title,
              cas.target_user_id,
              cas.priority,
              cas.original_created_at,
              cas.snapshot_at,
              cand.full_name as candidate_full_name,
              cand_role.name as candidate_role_name,
              cand_loc.name as candidate_location_name,
              cand_dept.name as candidate_department_name,
              tgt.full_name as target_full_name,
              tgt_role.name as target_role_name,
              tgt_loc.name as target_location_name,
              tgt_dept.name as target_department_name
            FROM campaign_applications_snapshot cas
            LEFT JOIN positions p ON p.id = cas.position_id
            LEFT JOIN users cand ON cand.id = cas.user_id
            LEFT JOIN roles cand_role ON cand_role.id = cand.role_id
            LEFT JOIN locations cand_loc ON cand_loc.id = cand.location_id
            LEFT JOIN departments cand_dept ON cand_dept.id = cand.department_id
            LEFT JOIN users tgt ON tgt.id = cas.target_user_id
            LEFT JOIN roles tgt_role ON tgt_role.id = tgt.role_id
            LEFT JOIN locations tgt_loc ON tgt_loc.id = tgt.location_id
            LEFT JOIN departments tgt_dept ON tgt_dept.id = tgt.department_id
            WHERE cas.campaign_id = $1
              AND cas.company_id = $2
              AND cas.perimeter_id = $3
            ORDER BY cas.priority ASC NULLS LAST, cas.original_created_at ASC NULLS LAST, cas.id ASC
            LIMIT 2000
            `,
            [campaignId, companyId, perimeterId]
        );

        return res.json({
            ok: true,
            campaign,
            applications: snapshotRes.rows,
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});
