import { Router } from "express";
export const graphProxyRouter = Router();
const GRAPH_SERVICE_URL = process.env.GRAPH_SERVICE_URL;
const GRAPH_SERVICE_TOKEN = process.env.GRAPH_SERVICE_TOKEN;
if (!GRAPH_SERVICE_URL)
    throw new Error("Missing GRAPH_SERVICE_URL");
if (!GRAPH_SERVICE_TOKEN)
    throw new Error("Missing GRAPH_SERVICE_TOKEN");
// Catch-all: qualunque path sotto /api/admin/graph/*
graphProxyRouter.use(async (req, res) => {
    try {
        const base = GRAPH_SERVICE_URL.replace(/\/+$/, "");
        const forwardPath = req.originalUrl.replace(/^\/api\/admin\/graph/, "");
        const url = `${base}${forwardPath || "/"}`;
        const headers = {
            "x-graph-token": GRAPH_SERVICE_TOKEN,
        };
        // Copia content-type se presente
        const ct = req.headers["content-type"];
        if (typeof ct === "string")
            headers["content-type"] = ct;
        // Copia anche accept se vuoi (non necessario)
        const accept = req.headers["accept"];
        if (typeof accept === "string")
            headers["accept"] = accept;
        const method = req.method.toUpperCase();
        const body = method === "GET" || method === "HEAD"
            ? undefined
            : (req.body ? JSON.stringify(req.body) : undefined);
        const resp = await fetch(url, { method, headers, body });
        const text = await resp.text();
        res.status(resp.status);
        // inoltra content-type del server se presente
        const respCt = resp.headers.get("content-type");
        if (respCt)
            res.setHeader("content-type", respCt);
        return res.send(text);
    }
    catch (e) {
        return res.status(502).json({ error: "Graph proxy failed", detail: String(e?.message ?? e) });
    }
});
//# sourceMappingURL=graphProxy.js.map