import { Router, Request, Response } from "express";
import { withTx, pool } from "../db.js";
import type { AuthedRequest } from "../auth.js";
import { audit } from "../audit.js";
import { createClient } from "@supabase/supabase-js";
import { invalidateMapCache } from "./map.js"; // aggiusta path corretto
import { requireAuth, requireAdmin } from "../auth.js";


export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL!;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN!;

if (!GRAPH_SERVICE_URL) throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN) throw new Error("Missing GRAPH_SERVICE_TOKEN");

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * POST /api/admin/test-scenarios/:id/initialize
 */
adminRouter.post(
    "/test-scenarios/:id/initialize",
    async (req: Request, res: Response) => {
        const r = req as AuthedRequest;
        const scenarioId = req.params.id;
        const correlationId = (req as any).correlationId;

        try {
            const result = await withTx(async (client) => {
                // 1) leggi scenario
                const rows = await client.query(
                    `
            select user_id, position_id, priority
            from test_scenario_applications
            where scenario_id = $1
        `,
                    [scenarioId]
                );

                // 2) reset stato
                await client.query(`
                    update users
                    set availability_status = 'inactive',
                        application_count = 0
                `);
                await client.query(`delete from applications`);

                // 3) inserisci applications
                await client.query(
                    `
            insert into applications (user_id, position_id, priority)
            select user_id, position_id, priority
            from test_scenario_applications
            where scenario_id = $1
        `,
                    [scenarioId]
                );

                // 4) riattiva utenti coinvolti:
                // - candidati (user_id)
                // - target (occupanti delle posizioni a cui ci si candida)
                await client.query(
                    `
                  update users
                  set availability_status = 'available'
                  where id in (
                -- candidati
                select distinct user_id
                from test_scenario_applications
                where scenario_id = $1

                union

                -- occupanti delle posizioni target
                select distinct p.occupied_by
                from test_scenario_applications tsa
                join positions p on p.id = tsa.position_id
                where tsa.scenario_id = $1
                  and p.occupied_by is not null
                  )
                  `,
                    [scenarioId]
                );


                // 5) riallinea application_count (consistenza)
                await client.query(`
                    update users u
                    set application_count = coalesce(x.cnt, 0)
                    from (
                        select u2.id as user_id, count(a.*)::int as cnt
                        from users u2
                        left join applications a on a.user_id = u2.id
                        group by u2.id
                    ) x
                    where u.id = x.user_id
                    `
                );


                await client.query(`
                    update users
                    set application_count = 0
                    where id not in (select distinct user_id from applications)
                `);


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
 * POST /api/admin/users/:id/deactivate
 */
adminRouter.post(
    "/users/:id/deactivate",
    async (req: Request, res: Response) => {
        const r = req as AuthedRequest;
        const userId = req.params.id;
        const correlationId = (req as any).correlationId;

        try {
            const out = await withTx(async (client) => {
                await client.query(`update users set availability_status = 'inactive' where id = $1`, [
                    userId,
                ]);
                await client.query(`delete from applications where user_id = $1`, [
                    userId,
                ]);
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
 * Aggiorna max_applications (singleton) e ribilancia le applications in modo deterministico.
 * Product rule: niente logica nel DB (no trigger), tutto in backend.
 */
adminRouter.post("/config/max-applications", async (req: Request, res: Response) => {
    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const { maxApplications } = req.body ?? {};
        const newMax = Number(maxApplications);

        if (!Number.isFinite(newMax) || newMax < 1 || newMax > 50) {
            return res.status(400).json({
                error: "Invalid maxApplications. Must be a number between 1 and 50.",
                correlationId,
            });
        }

        const out = await withTx(async (client) => {
            // 1) leggi old max (singleton)
            const oldRow = await client.query(
                `select max_applications from app_config where singleton = true limit 1`
            );
            const oldMax: number | null = oldRow.rows?.[0]?.max_applications ?? null;

            // 2) aggiorna config
            const upd = await client.query(
                `update app_config set max_applications = $1 where singleton = true`,
                [newMax]
            );

            // 3) se max aumenta o non cambia → nessun rebalance
            if (oldMax !== null && newMax >= oldMax) {
                return {
                    oldMax,
                    newMax,
                    rebalance: { performed: false, reason: "max did not decrease" },
                };
            }

            // 4) REBALANCE (solo se max diminuisce oppure oldMax null)
            // Regola deterministica:
            // - per ogni user_id, ordina apps per priority asc, created_at asc, id asc
            // - tieni le prime newMax
            // - set priority = 1..N (contigue)
            // - delete delle eccedenti
            //
            // NB: facciamo tutto SQL-side per performance, ma logica è nel backend (non trigger).
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
        )
        delete from applications a
        using ranked r
        where a.id = r.id
          and r.rn > $1
        `,
                [newMax]
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
        )
        update applications a
        set priority = r.rn
        from ranked r
        where a.id = r.id
          and a.priority is distinct from r.rn
        `
            );


            await client.query(`
        update users
        set application_count = 0
        where id not in (select distinct user_id from applications)
      `);

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
 * POST /api/admin/sync-graph
 * Rebuild completo del grafo Neo4j (on-demand, admin-only)
 */
adminRouter.post("/sync-graph", async (req, res) => {

    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        // 1) Leggi applications
        const { data: apps, error: appsErr } = await supabaseAdmin
            .from("applications")
            .select("user_id, position_id, priority");

        if (appsErr) {
            return res.status(500).json({ error: appsErr.message, correlationId });
        }

        const positionIds = Array.from(
            new Set((apps ?? []).map(a => a.position_id).filter(Boolean))
        );

        // 2) Leggi positions → occupied_by
        const { data: positions, error: posErr } = await supabaseAdmin
            .from("positions")
            .select("id, occupied_by")
            .in("id", positionIds);

        if (posErr) {
            return res.status(500).json({ error: posErr.message, correlationId });
        }

        const posToOccupant = new Map((positions ?? []).map(p => [p.id, p.occupied_by]));

        const edges = (apps ?? [])
            .map(a => ({
                user_id: a.user_id,
                target_user_id: posToOccupant.get(a.position_id) ?? null,
                priority: a.priority ?? null,
            }))
            .filter(e => e.user_id && e.target_user_id);

        // 3) usersById
        const userIds = Array.from(
            new Set(edges.flatMap(e => [e.user_id, e.target_user_id]).filter(Boolean))
        );

        const { data: users, error: usersErr } = await supabaseAdmin
            .from("users")
            .select("id, full_name")
            .in("id", userIds);

        if (usersErr) {
            return res.status(500).json({ error: usersErr.message, correlationId });
        }

        const usersById: Record<string, string> = {};
        for (const u of users ?? []) {
            usersById[u.id] = u.full_name ?? u.id;
        }

        // 4) Warmup Neo4j (best effort)
        try {
            await fetch(new URL("/neo4j/warmup", GRAPH_SERVICE_URL).toString(), {
                method: "POST",
                headers: { "x-graph-token": GRAPH_SERVICE_TOKEN },
            });
        } catch { }

        // 5) Build graph
        const buildRes = await fetch(new URL("/build-graph", GRAPH_SERVICE_URL).toString(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-graph-token": GRAPH_SERVICE_TOKEN,
            },
            body: JSON.stringify({ applications: edges, usersById }),
        });

        const buildJson = await buildRes.json().catch(() => null);

        if (!buildRes.ok) {
            return res.status(502).json({
                error: "Graph engine build-graph failed",
                engineStatus: buildRes.status,
                engineBody: buildJson,
                correlationId,
            });
        }

        await audit(
            "graph_sync",
            r.user.id,
            { edges: edges.length },
            buildJson,
            correlationId
        );

        return res.status(200).json({
            ok: true,
            correlationId,
            dataset: {
                applicationsRead: apps?.length ?? 0,
                edgesBuilt: edges.length,
                usersMapped: Object.keys(usersById).length,
            },
            engine: buildJson,
        });

    } catch (e: any) {
        return res.status(500).json({ error: e?.message ?? String(e), correlationId });
    }
});


adminRouter.post("/graph/summary", async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId;

    const resp = await fetch(new URL("/graph/summary", GRAPH_SERVICE_URL).toString(), {
        method: "POST",
        headers: { "x-graph-token": GRAPH_SERVICE_TOKEN },
    });

    const body = await resp.text();
    res.status(resp.status).type(resp.headers.get("content-type") ?? "application/json").send(body);
});


adminRouter.post("/graph/chains", async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId;

    const resp = await fetch(new URL("/graph/chains", GRAPH_SERVICE_URL).toString(), {
        method: "POST",
        headers: { "x-graph-token": GRAPH_SERVICE_TOKEN, "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
    });

    const body = await resp.text();
    res.status(resp.status).type(resp.headers.get("content-type") ?? "application/json").send(body);
});


adminRouter.post("/graph/warmup", async (req: Request, res: Response) => {
    const resp = await fetch(new URL("/neo4j/warmup", GRAPH_SERVICE_URL).toString(), {
        method: "POST",
        headers: { "x-graph-token": GRAPH_SERVICE_TOKEN },
    });

    const body = await resp.text();
    res.status(resp.status).type(resp.headers.get("content-type") ?? "application/json").send(body);
});


/**
 * POST /api/admin/users/reset-active
 * Setta active=false per tutti gli utenti (admin-only)
 */
adminRouter.post("/users/reset-active", async (req: Request, res: Response) => {

    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const out = await withTx(async (client) => {
            const delApps = await client.query(`delete from applications`);
            const updUsers = await client.query(`
                update users
                set availability_status = 'inactive',
                    application_count = 0
                where availability_status is distinct from 'inactive'
                   or application_count is distinct from 0
            `);

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

      order by a.created_at desc
      limit 500
      `
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
      order by full_name nulls last, id
      `
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
        const correlationId = (req as any).correlationId;
        const { full_name, email } = req.body ?? {};
        if (!full_name || !email) {
            return res.status(400).json({ ok: false, error: "missing full_name/email", correlationId });
        }

        const { rows } = await pool.query(
            `
      insert into users (full_name, email, availability_status)
      values ($1, $2, 'inactive')
      returning id, full_name, email, availability_status, location_id, fixed_location, role_id
      `,
            [String(full_name), String(email)]
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

        // opzionale: cleanup applications del user
        await pool.query(`delete from applications where user_id = $1`, [userId]);

        const del = await pool.query(`delete from users where id = $1`, [userId]);

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

        const { availability_status, location_id, fixed_location, role_id } = req.body ?? {};

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

        if (fields.length === 0) {
            return res.status(400).json({ ok: false, error: "empty patch", correlationId });
        }

        values.push(userId);

        const { rows } = await pool.query(
            `
      update users
      set ${fields.join(", ")}
      where id = $${i}
      returning id, full_name, email, availability_status, location_id, fixed_location, role_id
      `,
            values
        );

        invalidateMapCache();
        return res.json({ ok: true, user: rows?.[0] ?? null, correlationId });
    } catch (e) {
        next(e);
    }
});


adminRouter.get("/positions", async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
      select
        p.id,
        p.title,
        p.occupied_by
      from positions p
      order by p.title asc
      limit 1000
    `);
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
        const { rows } = await pool.query(`
      select id, name
      from test_scenarios
      order by created_at asc
      limit 500
    `);
        return res.json({ ok: true, scenarios: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});


adminRouter.get("/config", async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
      select max_applications
      from app_config
      where singleton = true
      limit 1
    `);
        return res.json({
            ok: true,
            config: rows?.[0] ?? null,
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});
