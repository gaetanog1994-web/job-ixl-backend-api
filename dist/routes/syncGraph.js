import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { audit } from "../audit.js";
import { classifyGraphFailure, reportError } from "../observability.js";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN;
if (!SUPABASE_URL)
    throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!GRAPH_SERVICE_URL)
    throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN)
    throw new Error("Missing GRAPH_SERVICE_TOKEN");
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
syncGraphRouter.post("/", async (req, res) => {
    const correlationId = req.correlationId;
    const actorId = req.user?.id ?? "unknown";
    try {
        const access = req.accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({ error: "Perimeter context required", correlationId });
        }
        // 1) Leggi applications (source of truth)
        const { data: apps, error: appsErr } = await supabaseAdmin
            .from("applications")
            .select("user_id, position_id, priority")
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (appsErr) {
            await reportError({
                event: "graph_sync_read_applications_failed",
                message: appsErr.message,
                correlationId,
                status: 500,
                code: "GRAPH_SYNC_READ_APPS_FAILED",
                operation: "sync_graph_read_applications",
            });
            return res.status(500).json({ error: appsErr.message, correlationId });
        }
        const positionIds = Array.from(new Set((apps ?? []).map((a) => a.position_id).filter(Boolean)));
        // 2) Leggi positions per ricavare target_user_id (occupied_by)
        const { data: positions, error: posErr } = await supabaseAdmin
            .from("positions")
            .select("id, occupied_by")
            .in("id", positionIds)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (posErr) {
            await reportError({
                event: "graph_sync_read_positions_failed",
                message: posErr.message,
                correlationId,
                status: 500,
                code: "GRAPH_SYNC_READ_POSITIONS_FAILED",
                operation: "sync_graph_read_positions",
            });
            return res.status(500).json({ error: posErr.message, correlationId });
        }
        const posToOccupant = new Map((positions ?? []).map((p) => [p.id, p.occupied_by]));
        const edges = (apps ?? [])
            .map((a) => ({
            user_id: a.user_id,
            target_user_id: posToOccupant.get(a.position_id) ?? null,
            priority: a.priority ?? null,
            company_id: access.currentCompanyId,
            perimeter_id: access.currentPerimeterId,
        }))
            .filter((e) => e.user_id && e.target_user_id);
        // 3) usersById (nome visualizzato in grafo)
        const userIds = Array.from(new Set(edges.flatMap((e) => [e.user_id, e.target_user_id]).filter(Boolean)));
        const { data: users, error: usersErr } = await supabaseAdmin
            .from("users")
            .select("id, full_name")
            .in("id", userIds)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (usersErr) {
            await reportError({
                event: "graph_sync_read_users_failed",
                message: usersErr.message,
                correlationId,
                status: 500,
                code: "GRAPH_SYNC_READ_USERS_FAILED",
                operation: "sync_graph_read_users",
            });
            return res.status(500).json({ error: usersErr.message, correlationId });
        }
        const usersById = {};
        for (const u of users ?? []) {
            if (u?.id)
                usersById[u.id] = u.full_name ?? u.id;
        }
        // 4) Chiama graph-engine: warmup (best-effort) + build-graph
        // warmup (non blocca)
        try {
            await fetch(new URL("/neo4j/warmup", GRAPH_SERVICE_URL).toString(), {
                method: "POST",
                headers: {
                    "x-graph-token": GRAPH_SERVICE_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    companyId: access.currentCompanyId,
                    perimeterId: access.currentPerimeterId,
                }),
            });
        }
        catch {
            // ignore
        }
        const buildRes = await fetch(new URL("/build-graph", GRAPH_SERVICE_URL).toString(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-graph-token": GRAPH_SERVICE_TOKEN,
            },
            body: JSON.stringify({
                applications: edges,
                usersById,
                companyId: access.currentCompanyId,
                perimeterId: access.currentPerimeterId,
            }),
        });
        const buildJson = await buildRes.json().catch(() => null);
        const buildPayload = typeof buildJson === "object" && buildJson !== null
            ? buildJson
            : null;
        if (!buildRes.ok) {
            const failure = classifyGraphFailure(buildRes.status, buildJson);
            const mappedStatus = failure.code === "GRAPH_WARMUP_WAIT" ? 503 : 502;
            const retryAfter = buildRes.headers.get("retry-after");
            if (retryAfter)
                res.setHeader("Retry-After", retryAfter);
            await reportError({
                event: "graph_sync_build_failed",
                message: String(buildPayload?.message ?? "Graph build failed"),
                correlationId,
                status: mappedStatus,
                code: failure.code,
                operation: "sync_graph_build_graph",
                meta: {
                    upstreamStatus: buildRes.status,
                    category: failure.category,
                },
            });
            await audit("graph_sync_rebuild", actorId, {
                companyId: access.currentCompanyId,
                perimeterId: access.currentPerimeterId,
            }, {
                ok: false,
                code: failure.code,
                upstreamStatus: buildRes.status,
            }, correlationId);
            return res.status(mappedStatus).json({
                error: failure.code,
                message: failure.code === "GRAPH_WARMUP_WAIT"
                    ? "Neo4j is waking up, retry in a few seconds"
                    : "Graph engine build-graph failed",
                engineStatus: buildRes.status,
                engineBody: buildJson,
                correlationId,
            });
        }
        await audit("graph_sync_rebuild", actorId, {
            companyId: access.currentCompanyId,
            perimeterId: access.currentPerimeterId,
        }, {
            ok: true,
            applicationsRead: apps?.length ?? 0,
            edgesBuilt: edges.length,
            usersMapped: Object.keys(usersById).length,
            upstreamStatus: buildRes.status,
        }, correlationId);
        return res.status(200).json({
            ok: true,
            correlationId,
            dataset: {
                applicationsRead: apps?.length ?? 0,
                applicationsScoped: apps?.length ?? 0,
                edgesBuilt: edges.length,
                usersMapped: Object.keys(usersById).length,
            },
            engine: buildJson,
        });
    }
    catch (e) {
        await reportError({
            event: "graph_sync_unhandled_failed",
            message: e?.message ?? String(e),
            correlationId,
            status: 500,
            code: "GRAPH_SYNC_UNHANDLED",
            operation: "sync_graph_rebuild",
        });
        await audit("graph_sync_rebuild", actorId, {}, { ok: false, error: e?.message ?? String(e) }, correlationId);
        return res.status(500).json({ error: e?.message ?? String(e), correlationId });
    }
});
//# sourceMappingURL=syncGraph.js.map