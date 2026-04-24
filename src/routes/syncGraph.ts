import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "../auth.js";
import { audit } from "../audit.js";
import { classifyGraphFailure, reportError } from "../observability.js";
import { requireOperationalPerimeterAdmin } from "../tenant.js";

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
syncGraphRouter.use(requireOperationalPerimeterAdmin);

/**
 * POST /api/admin/sync-graph
 * Prodotto-oriented: rebuild completo on-demand del grafo Neo4j.
 * - backend-api costruisce dataset da Supabase (source of truth)
 * - graph-engine esegue build-graph (token-only)
 */
syncGraphRouter.post("/", async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId;
    const actorId = (req as AuthedRequest).user?.id ?? "unknown";
    try {
        const access = (req as AuthedRequest).accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({
                ok: false,
                error: { code: "PERIMETER_CONTEXT_REQUIRED", message: "Perimeter context required" },
                correlationId,
            });
        }
        const campaignId = String((req.body as any)?.campaign_id ?? "").trim();
        if (!campaignId) {
            return res.status(400).json({
                ok: false,
                error: { code: "CAMPAIGN_ID_REQUIRED", message: "campaign_id is required" },
                correlationId,
            });
        }

        const { data: campaign, error: campaignErr } = await supabaseAdmin
            .from("campaigns")
            .select("id")
            .eq("id", campaignId)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId)
            .eq("status", "campaign_closed")
            .maybeSingle();
        if (campaignErr) {
            await reportError({
                event: "graph_sync_validate_campaign_failed",
                message: campaignErr.message,
                correlationId,
                status: 400,
                code: "GRAPH_SYNC_VALIDATE_CAMPAIGN_FAILED",
                operation: "sync_graph_validate_campaign",
            });
            return res.status(400).json({ error: campaignErr.message, correlationId });
        }
        if (!campaign?.id) {
            return res.status(404).json({
                ok: false,
                error: {
                    code: "CAMPAIGN_NOT_FOUND_OR_NOT_CLOSED",
                    message: "Campaign not found in scope or not closed",
                },
                correlationId,
            });
        }

        // 1) Leggi snapshot candidatura per la campagna selezionata
        const { data: apps, error: appsErr } = await supabaseAdmin
            .from("campaign_applications_snapshot")
            .select("user_id, target_user_id, priority")
            .eq("campaign_id", campaignId)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (appsErr) {
            await reportError({
                event: "graph_sync_read_snapshot_failed",
                message: appsErr.message,
                correlationId,
                status: 500,
                code: "GRAPH_SYNC_READ_SNAPSHOT_FAILED",
                operation: "sync_graph_read_snapshot",
            });
            return res.status(500).json({ error: appsErr.message, correlationId });
        }
        const edges = (apps ?? [])
            .map((a) => ({
                user_id: a.user_id,
                target_user_id: a.target_user_id ?? null,
                priority: a.priority ?? null,
                campaign_id: campaignId,
                company_id: access.currentCompanyId,
                perimeter_id: access.currentPerimeterId,
            }))
            .filter((e) => e.user_id && e.target_user_id);

        // 3) usersById (nome visualizzato in grafo)
        const userIds = Array.from(
            new Set(edges.flatMap((e) => [e.user_id, e.target_user_id]).filter(Boolean))
        );

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

        const usersById: Record<string, string> = {};
        for (const u of users ?? []) {
            if (u?.id) usersById[u.id] = u.full_name ?? u.id;
        }

        // 4) Chiama graph-engine: warmup (best-effort) + build-graph
        // warmup (non blocca)
        try {
            await fetch(new URL("/neo4j/warmup", GRAPH_SERVICE_URL).toString(), {
                method: "POST",
                headers: {
                    "x-graph-token": GRAPH_SERVICE_TOKEN,
                    "x-company-id": access.currentCompanyId,
                    "x-perimeter-id": access.currentPerimeterId,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    companyId: access.currentCompanyId,
                    perimeterId: access.currentPerimeterId,
                    company_id: access.currentCompanyId,
                    perimeter_id: access.currentPerimeterId,
                }),
            });
        } catch {
            // ignore
        }


        const buildRes = await fetch(new URL("/build-graph", GRAPH_SERVICE_URL).toString(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-graph-token": GRAPH_SERVICE_TOKEN,
                "x-company-id": access.currentCompanyId,
                "x-perimeter-id": access.currentPerimeterId,
            },
            body: JSON.stringify({
                applications: edges,
                usersById,
                campaignId,
                campaign_id: campaignId,
                companyId: access.currentCompanyId,
                perimeterId: access.currentPerimeterId,
                company_id: access.currentCompanyId,
                perimeter_id: access.currentPerimeterId,
            }),
        });

        const buildJson = await buildRes.json().catch(() => null);
        const buildPayload =
            typeof buildJson === "object" && buildJson !== null
                ? (buildJson as Record<string, unknown>)
                : null;

        if (!buildRes.ok) {
            const failure = classifyGraphFailure(buildRes.status, buildJson);
            const mappedStatus = failure.code === "GRAPH_WARMUP_WAIT" ? 503 : 502;
            const retryAfter = buildRes.headers.get("retry-after");
            if (retryAfter) res.setHeader("Retry-After", retryAfter);

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

            await audit(
                "graph_sync_rebuild",
                actorId,
                {
                    companyId: access.currentCompanyId,
                    perimeterId: access.currentPerimeterId,
                },
                {
                    ok: false,
                    code: failure.code,
                    upstreamStatus: buildRes.status,
                },
                correlationId
                ,
                {
                    companyId: access.currentCompanyId,
                    perimeterId: access.currentPerimeterId,
                }
            );

            return res.status(mappedStatus).json({
                error: failure.code,
                message:
                    failure.code === "GRAPH_WARMUP_WAIT"
                        ? "Neo4j is waking up, retry in a few seconds"
                        : "Graph engine build-graph failed",
                engineStatus: buildRes.status,
                engineBody: buildJson,
                correlationId,
            });
        }

        await audit(
            "graph_sync_rebuild",
            actorId,
            {
                companyId: access.currentCompanyId,
                perimeterId: access.currentPerimeterId,
            },
            {
                ok: true,
                campaignId,
                applicationsRead: apps?.length ?? 0,
                edgesBuilt: edges.length,
                usersMapped: Object.keys(usersById).length,
                upstreamStatus: buildRes.status,
            },
            correlationId,
            {
                companyId: access.currentCompanyId,
                perimeterId: access.currentPerimeterId,
            }
        );

        return res.status(200).json({
            ok: true,
            correlationId,
            dataset: {
                campaignId,
                applicationsRead: apps?.length ?? 0,
                applicationsScoped: apps?.length ?? 0,
                edgesBuilt: edges.length,
                usersMapped: Object.keys(usersById).length,
            },
            engine: buildJson,
        });
    } catch (e: any) {
        await reportError({
            event: "graph_sync_unhandled_failed",
            message: e?.message ?? String(e),
            correlationId,
            status: 500,
            code: "GRAPH_SYNC_UNHANDLED",
            operation: "sync_graph_rebuild",
        });

        await audit(
            "graph_sync_rebuild",
            actorId,
            {},
            { ok: false, error: e?.message ?? String(e) },
            correlationId
        );
        return res.status(500).json({
            ok: false,
            error: { code: "GRAPH_SYNC_UNHANDLED", message: e?.message ?? String(e) },
            correlationId,
        });
    }
});
