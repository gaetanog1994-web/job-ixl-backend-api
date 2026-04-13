import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "../auth.js";

export const graphProxyRouter = Router();

const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL!;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN!;

if (!GRAPH_SERVICE_URL) throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN) throw new Error("Missing GRAPH_SERVICE_TOKEN");

// Catch-all: qualunque path sotto /api/admin/graph/*
graphProxyRouter.use(async (req: Request, res: Response) => {
    try {
        const access = (req as AuthedRequest).accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({
                ok: false,
                error: { code: "PERIMETER_CONTEXT_REQUIRED", message: "Perimeter context required" },
                correlationId: (req as any).correlationId ?? null,
            });
        }

        const base = GRAPH_SERVICE_URL.replace(/\/+$/, "");
        let forwardPath = req.originalUrl.replace(/^\/api\/admin\/graph/, "") || "/";

        if (forwardPath === "/warmup") forwardPath = "/neo4j/warmup";

        const targetUrl = new URL(`${base}${forwardPath}`);

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
        res.status(resp.status);

        const respCt = resp.headers.get("content-type");
        if (respCt) res.setHeader("content-type", respCt);

        return res.send(text);
    } catch (e: any) {
        return res.status(502).json({
            ok: false,
            error: { code: "GRAPH_PROXY_FAILED", message: "Graph proxy failed", detail: String(e?.message ?? e) },
            correlationId: (req as any).correlationId ?? null,
        });
    }
});
