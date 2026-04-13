import { Router, Request, Response } from "express";
import { withTx, pool, supabaseAdmin } from "../db.js";
import type { AuthedRequest } from "../auth.js";
import { audit } from "../audit.js";
import { invalidateMapCache } from "./map.js";
import { graphAdminRouter } from "./graphAdmin.js";

export const adminRouter = Router();
adminRouter.use("/graph", graphAdminRouter);

const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL!;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN!;

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

/**
 * POST /api/admin/test-scenarios/:id/initialize
 */
adminRouter.post(
    "/test-scenarios/:id/initialize",
    async (req: Request, res: Response) => {
        const r = req as unknown as AuthedRequest;
        const scenarioId = req.params.id;
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);

        try {
            const result = await withTx(async (client) => {
                const rows = await client.query(
                    `
            select user_id, position_id, priority
            from test_scenario_applications
            where scenario_id = $1
              and company_id = $2
              and perimeter_id = $3
        `,
                    [scenarioId, companyId, perimeterId]
                );

                await client.query(`
                    update users
                    set availability_status = 'inactive',
                        application_count = 0
                    where company_id = $1
                      and coalesce(perimeter_id, home_perimeter_id) = $2
                `, [companyId, perimeterId]);
                await client.query(`delete from applications where company_id = $1 and perimeter_id = $2`, [companyId, perimeterId]);

                await client.query(
                    `
            insert into applications (user_id, position_id, priority, company_id, perimeter_id)
            select user_id, position_id, priority, company_id, perimeter_id
            from test_scenario_applications
            where scenario_id = $1
              and company_id = $2
              and perimeter_id = $3
        `,
                    [scenarioId, companyId, perimeterId]
                );

                await client.query(
                    `
                  update users
                  set availability_status = 'available'
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
                  `,
                    [scenarioId, companyId, perimeterId]
                );

                await client.query(`
                    update users u
                    set application_count = coalesce(x.cnt, 0)
                    from (
                        select u2.id as user_id, count(a.*)::int as cnt
                        from users u2
                        left join applications a on a.user_id = u2.id and a.company_id = $1 and a.perimeter_id = $2
                        where u2.company_id = $1
                          and coalesce(u2.perimeter_id, u2.home_perimeter_id) = $2
                        group by u2.id
                    ) x
                    where u.id = x.user_id
                    `,
                    [companyId, perimeterId]
                );

                await client.query(`
                    update users
                    set application_count = 0
                    where company_id = $1
                      and coalesce(perimeter_id, home_perimeter_id) = $2
                      and id not in (
                        select distinct user_id from applications where company_id = $1 and perimeter_id = $2
                      )
                `, [companyId, perimeterId]);

                return {
                    insertedApplications: rows.rowCount,
                    activatedUsers: rows.rowCount,
                };
            });

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
            await audit(
                "scenario_initialize",
                r.user.id,
                { scenarioId },
                { error: String(e?.message ?? e) },
                correlationId
            );
            return res.status(500).json({ error: "Initialize failed", correlationId });
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
adminRouter.get("/users/active", async (req, res, next) => {
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
 */
adminRouter.post(
    "/users/:id/deactivate",
    async (req: Request, res: Response) => {
        const r = req as unknown as AuthedRequest;
        const userId = req.params.id;
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);

        try {
            const out = await withTx(async (client) => {
                await client.query(
                    `update users
                     set availability_status = 'inactive', updated_by = $1
                     where id = $2
                       and company_id = $3
                       and coalesce(perimeter_id, home_perimeter_id) = $4`,
                    [r.user.id, userId, companyId, perimeterId]
                );
                await client.query(
                    `delete from applications where user_id = $1 and company_id = $2 and perimeter_id = $3`,
                    [userId, companyId, perimeterId]
                );
                return { deactivatedUserId: userId };
            });

            invalidateMapCache();

            await audit(
                "user_deactivate",
                r.user.id,
                { userId },
                out,
                correlationId
            );

            return res.status(200).json({ ok: true, out, correlationId });
        } catch (e: any) {
            await audit(
                "user_deactivate",
                r.user.id,
                { userId },
                { error: String(e?.message ?? e) },
                correlationId
            );
            return res.status(500).json({ error: "Deactivate failed", correlationId });
        }
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

            const rebalanceDelete = await client.query(
                `
        with ranked as (
          select
            id,
            user_id,
            row_number() over (
              partition by user_id
              order by priority asc nulls last, created_at asc, id asc
            ) as rn
          from applications
          where company_id = $2 and perimeter_id = $3
        )
        delete from applications a
        using ranked r
        where a.id = r.id
          and r.rn > $1
        `,
                [newMax, companyId, perimeterId]
            );

            const rebalanceUpdate = await client.query(
                `
        with ranked as (
          select
            id,
            user_id,
            row_number() over (
              partition by user_id
              order by priority asc nulls last, created_at asc, id asc
            ) as rn
          from applications
          where company_id = $1 and perimeter_id = $2
        )
        update applications a
        set priority = r.rn
        from ranked r
        where a.id = r.id
          and a.priority is distinct from r.rn
        `,
                [companyId, perimeterId]
            );

            await client.query(`
        update users
        set application_count = 0
        where company_id = $1
          and coalesce(perimeter_id, home_perimeter_id) = $2
          and id not in (
            select distinct user_id from applications where company_id = $1 and perimeter_id = $2
          )
      `, [companyId, perimeterId]);

            return {
                oldMax,
                newMax,
                rebalance: {
                    performed: true,
                    deleted: rebalanceDelete.rowCount ?? 0,
                    prioritiesUpdated: rebalanceUpdate.rowCount ?? 0,
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
 */
adminRouter.post("/users/reset-active", async (req: Request, res: Response) => {
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

adminRouter.get("/candidatures", async (req, res, next) => {
    try {
        const { companyId, perimeterId } = getTenantScope(req);
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
        occ_loc.name as occupant_location_name

      from applications a
      join users cand on cand.id = a.user_id

      join positions p on p.id = a.position_id
      join users occ on occ.id = p.occupied_by

      left join roles cand_role on cand_role.id = cand.role_id
      left join locations cand_loc on cand_loc.id = cand.location_id

      left join roles occ_role on occ_role.id = occ.role_id
      left join locations occ_loc on occ_loc.id = occ.location_id

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

adminRouter.get("/users", async (req, res, next) => {
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
        u.location_id,
        l.name as location_name,
        u.fixed_location,
        u.role_id,
        r.name as role_name,
        pm.access_role,
        u.company_id,
        u.home_perimeter_id
      from perimeter_memberships pm
      join users u on u.id = pm.user_id
      left join locations l on l.id = u.location_id
      left join roles r on r.id = u.role_id
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

adminRouter.post("/users", async (req, res, next) => {
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

adminRouter.delete("/users/:id", async (req, res, next) => {
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

adminRouter.patch("/users/:id", async (req, res, next) => {
    try {
        const userId = req.params.id;
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);

        const { availability_status, location_id, fixed_location, role_id, access_role } = req.body ?? {};

        const fields: string[] = [];
        const values: any[] = [];
        let i = 1;

        const push = (name: string, value: any) => {
            fields.push(`${name} = $${i++}`);
            values.push(value);
        };

        if (availability_status !== undefined) {
            if (availability_status !== "available" && availability_status !== "inactive") {
                return res.status(400).json({ ok: false, error: "invalid availability_status", correlationId });
            }
            push("availability_status", availability_status);
        }

        if (location_id !== undefined) push("location_id", location_id || null);
        if (fixed_location !== undefined) push("fixed_location", !!fixed_location);
        if (role_id !== undefined) push("role_id", role_id || null);

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
      returning id, full_name, email, availability_status, location_id, fixed_location, role_id, company_id, perimeter_id
      `,
            values
        ) : { rows: [] as any[] };

        const userFromDb = rows?.[0]
            ? rows[0]
            : (await pool.query(
                `
                select id, full_name, email, availability_status, location_id, fixed_location, role_id, company_id, perimeter_id
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
        const { rows } = await pool.query(`
      select id, name
      from roles
      order by name asc
      limit 2000
    `);
        return res.json({ ok: true, roles: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
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

adminRouter.post("/roles", async (req, res, next) => {
    try {
        const { name } = req.body ?? {};
        if (!name) return res.status(400).json({ ok: false, error: "missing name" });

        const { rows } = await pool.query(
            `insert into roles (name) values ($1) returning id, name`,
            [String(name)]
        );

        invalidateMapCache();
        return res.status(201).json({ ok: true, role: rows[0], correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

adminRouter.delete("/roles/:id", async (req, res, next) => {
    try {
        const id = req.params.id;
        const del = await pool.query(`delete from roles where id = $1`, [id]);
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
adminRouter.get("/interlocking-scenarios", async (req: Request, res: Response, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);

        const { rows } = await pool.query(
            `
            select
              id,
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
            order by generated_at desc, created_at desc
            limit 500
            `
            ,
            [companyId, perimeterId]
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

adminRouter.get("/interlocking-scenarios/export.csv", async (req: Request, res: Response, next) => {
    try {
        const correlationId = (req as any).correlationId;
        const { companyId, perimeterId } = getTenantScope(req);

        const { rows } = await pool.query(
            `
            select
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
            order by generated_at desc, created_at desc
            limit 5000
            `,
            [companyId, perimeterId]
        );

        const headers = [
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
adminRouter.post("/interlocking-scenarios", async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const {
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

        if (!scenario_code || !generated_at || !strategy || !Number.isFinite(Number(max_len))) {
            return res.status(400).json({
                ok: false,
                error: "invalid body",
                correlationId,
            });
        }

        const { rows } = await pool.query(
            `
            insert into interlocking_scenarios (
              company_id,
              perimeter_id,
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
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb
            )
            returning
              id,
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
            { scenario_code: String(scenario_code) },
            { scenario },
            correlationId
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
            { body: req.body ?? {} },
            { error: String(e?.message ?? e) },
            correlationId
        );

        return res.status(500).json({
            ok: false,
            error: "Create interlocking scenario failed",
            detail: String(e?.message ?? e),
            correlationId,
        });
    }
});

/**
 * DELETE /api/admin/interlocking-scenarios
 * body: { ids: string[] }
 */
adminRouter.delete("/interlocking-scenarios", async (req: Request, res: Response) => {
    const r = req as unknown as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const { companyId, perimeterId } = getTenantScope(req);
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];

        if (ids.length === 0) {
            return res.status(400).json({
                ok: false,
                error: "ids required",
                correlationId,
            });
        }

        const del = await pool.query(
            `
            delete from interlocking_scenarios
            where id = any($1::uuid[])
              and company_id = $2
              and perimeter_id = $3
            `,
            [ids, companyId, perimeterId]
        );

        const out = {
            requested: ids.length,
            deleted: del.rowCount ?? 0,
        };

        await audit(
            "interlocking_scenario_delete_many",
            r.user.id,
            { ids },
            out,
            correlationId
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
            { ids: req.body?.ids ?? null },
            { error: String(e?.message ?? e) },
            correlationId
        );

        return res.status(500).json({
            ok: false,
            error: "Delete interlocking scenarios failed",
            detail: String(e?.message ?? e),
            correlationId,
        });
    }
});
