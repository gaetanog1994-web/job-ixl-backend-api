import { Router, Request, Response } from "express";
import { withTx } from "../db.js";
import type { AuthedRequest } from "../auth.js";
import { audit } from "../audit.js";
import { createClient } from "@supabase/supabase-js";


export const adminRouter = Router();

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
            where test_scenario_id = $1
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
            where test_scenario_id = $1
        `,
                    [scenarioId]
                );

                // 4) riattiva utenti coinvolti
                await client.query(
                    `
          update users
          set availability_status = 'active'
          where id in (
            select distinct user_id
            from test_scenario_applications
            where test_scenario_id = $1
          )
        `,
                    [scenarioId]
                );

                return {
                    insertedApplications: rows.rowCount,
                    activatedUsers: rows.rowCount,
                };
            });

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
 * POST /api/admin/sync-graph
 * Rebuild completo del grafo Neo4j (on-demand, admin-only)
 */
adminRouter.post("/sync-graph", async (req: Request, res: Response) => {
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
