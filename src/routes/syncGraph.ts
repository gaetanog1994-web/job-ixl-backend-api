import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL!;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN!;

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!GRAPH_SERVICE_URL) throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN) throw new Error("Missing GRAPH_SERVICE_TOKEN");

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

export const syncGraphRouter = Router();

/**
 * POST /api/admin/sync-graph
 * Prodotto-oriented: rebuild completo on-demand del grafo Neo4j.
 * - backend-api costruisce dataset da Supabase (source of truth)
 * - graph-engine esegue build-graph (token-only)
 */
syncGraphRouter.post("/", async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId;
    try {
        // 1) Leggi applications (source of truth)
        const { data: apps, error: appsErr } = await supabaseAdmin
            .from("applications")
            .select("user_id, position_id, priority");
        if (appsErr) {
            return res.status(500).json({ error: appsErr.message, correlationId });
        }

        const positionIds = Array.from(
            new Set((apps ?? []).map((a) => a.position_id).filter(Boolean))
        );

        // 2) Leggi positions per ricavare target_user_id (occupied_by)
        const { data: positions, error: posErr } = await supabaseAdmin
            .from("positions")
            .select("id, occupied_by")
            .in("id", positionIds);
        if (posErr) {
            return res.status(500).json({ error: posErr.message, correlationId });
        }

        const posToOccupant = new Map((positions ?? []).map((p) => [p.id, p.occupied_by]));
        const edges = (apps ?? [])
            .map((a) => ({
                user_id: a.user_id,
                target_user_id: posToOccupant.get(a.position_id) ?? null,
                priority: a.priority ?? null,
            }))
            .filter((e) => e.user_id && e.target_user_id);

        // 3) usersById (nome visualizzato in grafo)
        const userIds = Array.from(
            new Set(edges.flatMap((e) => [e.user_id, e.target_user_id]).filter(Boolean))
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
            if (u?.id) usersById[u.id] = u.full_name ?? u.id;
        }

        // 4) Chiama graph-engine: warmup (best-effort) + build-graph
        // warmup (non blocca)
        try {
            await fetch(new URL("/neo4j/warmup", GRAPH_SERVICE_URL).toString(), {
                method: "POST",
                headers: { "x-graph-token": GRAPH_SERVICE_TOKEN },
            });
        } catch {
            // ignore
        }

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
