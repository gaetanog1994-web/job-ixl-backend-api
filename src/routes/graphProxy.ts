import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "../auth.js";
import { audit } from "../audit.js";
import { classifyGraphFailure, reportError } from "../observability.js";
import { requireOperationalPerimeterAdmin } from "../tenant.js";

export const graphProxyRouter = Router();
graphProxyRouter.use(requireOperationalPerimeterAdmin);

const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL!;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN!;

if (!GRAPH_SERVICE_URL) throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN) throw new Error("Missing GRAPH_SERVICE_TOKEN");

// Catch-all: qualunque path sotto /api/admin/graph/*
graphProxyRouter.use(async (req: Request, res: Response) => {
    const correlationId = (req as any).correlationId ?? null;
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

        const base = GRAPH_SERVICE_URL.replace(/\/+$/, "");
        let forwardPath = req.originalUrl.replace(/^\/api\/admin\/graph/, "") || "/";

        if (forwardPath === "/warmup") forwardPath = "/neo4j/warmup";

        const targetUrl = new URL(`${base}${forwardPath}`);
        const isCriticalGraphOperation =
            forwardPath === "/neo4j/warmup" ||
            forwardPath === "/graph/chains" ||
            forwardPath === "/graph/summary" ||
            forwardPath === "/build-graph";

        const headers: Record<string, string> = {
            "x-graph-token": GRAPH_SERVICE_TOKEN,
            "x-company-id": access.currentCompanyId,
            "x-perimeter-id": access.currentPerimeterId,
        };

        const ct = req.headers["content-type"];
        if (typeof ct === "string") headers["content-type"] = ct;

        const accept = req.headers["accept"];
        if (typeof accept === "string") headers["accept"] = accept;

        const method = req.method.toUpperCase();
        let body: string | undefined;
        if (method !== "GET" && method !== "HEAD") {
            const sourceBody = req.body && typeof req.body === "object" ? req.body : {};
            body = JSON.stringify({
                ...sourceBody,
                companyId: access.currentCompanyId,
                perimeterId: access.currentPerimeterId,
            });
        } else {
            targetUrl.searchParams.set("companyId", access.currentCompanyId);
            targetUrl.searchParams.set("perimeterId", access.currentPerimeterId);
        }

        async function doFetch(url: URL) {
            return fetch(url.toString(), { method, headers, body });
        }

        // 1) prima prova
        let resp = await doFetch(targetUrl);

        // 2) fallback /api se 404 (utile per future routes)
        if (resp.status === 404 && !forwardPath.startsWith("/api/")) {
            const fallback = new URL(`${base}/api${forwardPath}`);
            fallback.search = targetUrl.search;
            resp = await doFetch(fallback);
        }

        const text = await resp.text();
        let parsedBody: any = null;
        try {
            parsedBody = text ? JSON.parse(text) : null;
        } catch {
            parsedBody = null;
        }

        if (isCriticalGraphOperation) {
            await audit(
                "graph_proxy_call",
                actorId,
                {
                    method,
                    forwardPath,
                    companyId: access.currentCompanyId,
                    perimeterId: access.currentPerimeterId,
                },
                {
                    ok: resp.ok,
                    status: resp.status,
                    graphStatus: parsedBody?.status ?? null,
                },
                correlationId
            );
        }

        if (!resp.ok && resp.status >= 500) {
            const failure = classifyGraphFailure(resp.status, parsedBody);
            await reportError({
                event: "graph_proxy_upstream_failed",
                message: String(parsedBody?.message ?? parsedBody?.error ?? "Graph proxy upstream failure"),
                correlationId,
                status: resp.status,
                code: failure.code,
                operation: `graph_proxy:${forwardPath}`,
                meta: { category: failure.category },
            });
        }

        res.status(resp.status);

        const respCt = resp.headers.get("content-type");
        if (respCt) res.setHeader("content-type", respCt);
        const retryAfter = resp.headers.get("retry-after");
        if (retryAfter) res.setHeader("Retry-After", retryAfter);

        return res.send(text);
    } catch (e: any) {
        await reportError({
            event: "graph_proxy_failed",
            message: String(e?.message ?? e),
            correlationId,
            status: 502,
            code: "GRAPH_PROXY_FAILED",
            operation: `${req.method} ${req.originalUrl}`,
        });

        await audit(
            "graph_proxy_call",
            actorId,
            { method: req.method, forwardPath: req.originalUrl },
            { ok: false, error: String(e?.message ?? e) },
            correlationId
        );

        return res.status(502).json({
            ok: false,
            error: { code: "GRAPH_PROXY_FAILED", message: "Graph proxy failed", detail: String(e?.message ?? e) },
            correlationId,
        });
    }
});
