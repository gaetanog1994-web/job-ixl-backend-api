import { Router } from "express";
import type { Request, Response, NextFunction } from "express";

export const graphProxyRouter = Router();

const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL!;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN!;

if (!GRAPH_SERVICE_URL) throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN) throw new Error("Missing GRAPH_SERVICE_TOKEN");

// Catch-all: qualunque path sotto /api/admin/graph/*
graphProxyRouter.use(async (req: Request, res: Response) => {
    try {
        const base = GRAPH_SERVICE_URL.replace(/\/+$/, "");
        let forwardPath = req.originalUrl.replace(/^\/api\/admin\/graph/, "") || "/";

        // RC1: warmup non esiste sul graph-engine → alias a /health
        if (forwardPath === "/warmup") forwardPath = "/health";

        const headers: Record<string, string> = { "x-graph-token": GRAPH_SERVICE_TOKEN };

        const ct = req.headers["content-type"];
        if (typeof ct === "string") headers["content-type"] = ct;

        const accept = req.headers["accept"];
        if (typeof accept === "string") headers["accept"] = accept;

        const method = req.method.toUpperCase();
        const body =
            method === "GET" || method === "HEAD"
                ? undefined
                : (req.body ? JSON.stringify(req.body) : undefined);

        async function doFetch(path: string) {
            const url = `${base}${path}`;
            return fetch(url, { method, headers, body });
        }

        // 1) prima prova
        let resp = await doFetch(forwardPath);

        // 2) fallback /api se 404 (utile per future routes)
        if (resp.status === 404 && !forwardPath.startsWith("/api/")) {
            resp = await doFetch(`/api${forwardPath}`);
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

