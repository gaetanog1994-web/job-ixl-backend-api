import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import type { AuthedRequest } from "./auth.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { correlation } from "./audit.js";
import { logInfo, reportError } from "./observability.js";
import { adminRouter } from "./routes/admin.js";
import { graphProxyRouter } from "./routes/graphProxy.js";
import { pool } from "./db.js";
import { syncGraphRouter } from "./routes/syncGraph.js";
import { mapRouter } from "./routes/map.js";
import { applicationsRouter } from "./routes/applications.js";
import { usersRouter } from "./routes/users.js";
import { publicRouter } from "./routes/public.js";
import { graphAdminRouter } from "./routes/graphAdmin.js";
import { platformRouter } from "./routes/platform.js";
import {
    attachAccessContext,
    requirePerimeterAccess,
    requirePerimeterAdmin,
    requireTenantScope,
} from "./tenant.js";

const app = express();

function getCorrelationId(req: any) {
    return req?.correlationId ?? null;
}

function sendError(
    res: any,
    req: any,
    status: number,
    code: string,
    message: string,
    extra?: any
) {
    const correlationId = getCorrelationId(req);
    return res.status(status).json({
        ok: false,
        error: { code, message, ...(extra ? { extra } : {}) },
        correlationId,
    });
}

app.set("trust proxy", 1);

logInfo("backend_boot", null, { version: "BETA5" });

/**
 * CORS
 * Nota:
 * - in locale consenti 5173 e 5174
 * - in produzione puoi aggiungere origin FE deployate via env
 */
const envAllowlist = (process.env.CORS_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const defaultDevOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
];

const allowedOrigins = Array.from(new Set([...defaultDevOrigins, ...envAllowlist]));
const appEnv = (process.env.APP_ENV ?? (process.env.NODE_ENV === "production" ? "production" : "development"))
    .toLowerCase();
const isProduction = appEnv === "production";
const isDevelopment = appEnv === "development";
const ENABLE_DEBUG_ENDPOINTS =
    !isProduction &&
    (
        process.env.ENABLE_DEBUG_ENDPOINTS === "true" ||
        (isDevelopment && process.env.ENABLE_DEBUG_ENDPOINTS !== "false")
    );

// CORS PRIMA delle route
app.use(
    cors({
        origin: (
            origin: string | undefined,
            cb: (err: Error | null, allow?: boolean) => void
        ) => {
            // richieste server-to-server / curl / healthcheck
            if (!origin) return cb(null, true);

            if (allowedOrigins.includes(origin)) {
                return cb(null, true);
            }

            console.error("CORS_BLOCKED", { origin, allowedOrigins });
            return cb(new Error("CORS blocked"), false);
        },
        credentials: true,
    })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(correlation);

app.get("/api/me", requireAuth, attachAccessContext, (req, res) => {
    const r = req as AuthedRequest;
    res.json({
        user: r.user,
        isAdmin: r.accessContext?.canManagePerimeter === true,
        isOwner: r.accessContext?.isOwner === true,
        isSuperAdmin: r.accessContext?.isCompanySuperAdmin === true,
        access: r.accessContext ?? null,
    });
});

// ✅ DOPO CORS
// Keep /api/me above generic /api middleware, otherwise requireTenantScope
// can intercept it and incorrectly return PERIMETER_CONTEXT_REQUIRED.
app.use("/api/platform", requireAuth, attachAccessContext, platformRouter);
app.use("/api/users", requireAuth, attachAccessContext, requireTenantScope, usersRouter);
app.use("/api/public", publicRouter);

app.get("/api/config", requireAuth, attachAccessContext, requirePerimeterAccess, async (req, res, next) => {
    try {
        const access = (req as AuthedRequest).accessContext!;
        const { rows } = await pool.query(`
            select max_applications
            from app_config
            where singleton = true
              and company_id = $1
              and perimeter_id = $2
            limit 1
        `, [access.currentCompanyId, access.currentPerimeterId]);

        return res.json({
            ok: true,
            config: rows?.[0] ?? null,
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (e) {
        next(e);
    }
});

// Health pubblico (no auth)
app.get("/health", async (_req: express.Request, res: express.Response) => {
    try {
        await pool.query("select 1");
        return res.status(200).json({
            ok: true,
            correlationId: getCorrelationId(_req),
        });
    } catch (e: any) {
        console.error("HEALTH_DB_FAILED", {
            message: e?.message ?? String(e),
            code: e?.code,
        });
        return sendError(
            res,
            _req,
            503,
            "DB_UNAVAILABLE",
            e?.message ?? String(e)
        );
    }
});

if (ENABLE_DEBUG_ENDPOINTS) {
    app.get("/api/_debug/ping", (req, res) => {
        return res.json({
            ok: true,
            ping: "pong",
            correlationId: getCorrelationId(req),
        });
    });
}

// Rate limit — admin (60 req/min per user/IP)
const adminLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const key = (req as any).user?.id ?? req.ip;
        console.log("ADMIN_LIMIT_KEY", {
            path: req.originalUrl,
            method: req.method,
            userId: (req as any).user?.id ?? null,
            ip: req.ip,
            key,
        });
        return key;
    },
    handler: (req, res, _next, options) => {
        console.error("ADMIN_RATE_LIMIT_HIT", {
            path: req.originalUrl,
            method: req.method,
            userId: (req as any).user?.id ?? null,
            ip: req.ip,
            key: (req as any).user?.id ?? req.ip,
            statusCode: options.statusCode,
        });
        return sendError(res, req, options.statusCode, "RATE_LIMITED", "Too many requests");
    },
});

// Rate limit — apply endpoint (30 req/min per IP) §2.6
const applyLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    // Scope only to POST /api/users/:userId/applications/bulk
    skip: (req) => {
        if (req.method !== "POST") return true;
        return !/^\/users\/[^/]+\/applications\/bulk$/.test(req.path);
    },
    keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? "unknown",
    handler: (req, res, _next, options) =>
        sendError(res, req, options.statusCode, "RATE_LIMITED", "Too many requests"),
});

// Rate limit — map endpoint (60 req/min per user/IP) §2.6
const mapLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? "unknown",
    handler: (req, res, _next, options) =>
        sendError(res, req, options.statusCode, "RATE_LIMITED", "Too many requests"),
});

app.use("/api/map", requireAuth, mapLimiter, attachAccessContext, requirePerimeterAccess, mapRouter);
app.use("/api", requireAuth, applyLimiter, attachAccessContext, requireTenantScope, applicationsRouter);

// Stack admin unico
const adminApi = express.Router();

// Order: attachAccessContext before requireAdmin to avoid double DB call.
// requireAdmin reads r.accessContext set by attachAccessContext.
// requirePerimeterAdmin removed: requireAdmin already enforces canManagePerimeter.
adminApi.use(requireAuth, adminLimiter, attachAccessContext, requireAdmin);

// 1) rotte admin “normali”
adminApi.use("/", adminRouter);

// 2) graph sync
adminApi.use("/sync-graph", syncGraphRouter);
adminApi.use((req, _res, next) => {
    console.log("ADMIN_REQ", {
        method: req.method,
        path: req.originalUrl,
        userId: (req as any).user?.id ?? null,
        ip: req.ip,
    });
    next();
});

// 3) graph chains server-side (Postgres SoT path, intentionally before proxy)
adminApi.use("/graph", graphAdminRouter);

// 4) graph proxy (Neo4j warmup/summary and other forwarded graph endpoints)
adminApi.use("/graph", graphProxyRouter);

// mount unico
app.use("/api/admin", adminApi);

if (ENABLE_DEBUG_ENDPOINTS) {
    app.post("/_debug/auth-check", async (req: express.Request, res: express.Response) => {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;

        if (!token) {
            return res.status(400).json({
                ok: false,
                error: "Missing Bearer",
            });
        }

        try {
            const { createClient } = await import("@supabase/supabase-js");
            const supabase = createClient(
                process.env.SUPABASE_URL!,
                process.env.SUPABASE_SERVICE_ROLE_KEY!,
                {
                    auth: { persistSession: false, autoRefreshToken: false },
                }
            );

            const { data, error } = await supabase.auth.getUser(token);

            return res.status(200).json({
                ok: !error,
                error: error?.message ?? null,
                user: data?.user
                    ? { id: data.user.id, email: data.user.email }
                    : null,
            });
        } catch (err: any) {
            console.error("❌ auth-check error FULL:", err);
            console.error("❌ message:", err?.message);
            console.error("❌ details:", err?.details);
            console.error("❌ hint:", err?.hint);
            console.error("❌ stack:", err?.stack);

            return res.status(500).json({
                error: "AUTH_CHECK_FAILED",
                message: err?.message ?? null,
            });
        }
    });
}

// 404 JSON
app.use((req, res) => {
    return sendError(res, req, 404, "NOT_FOUND", "Route not found");
});

// Error handler globale
app.use((err: any, req: any, res: any, _next: any) => {
    if (res.headersSent) return;

    const msg = String(err?.message ?? "Unknown error");

    if (msg === "CORS blocked") {
        return sendError(res, req, 403, "CORS_BLOCKED", "Origin not allowed", {
            origin: req.headers.origin ?? null,
        });
    }

    const status = Number(err?.status ?? err?.statusCode ?? 500);

    const code =
        status === 401
            ? "UNAUTHORIZED"
            : status === 403
                ? "FORBIDDEN"
                : status === 429
                    ? "RATE_LIMITED"
                    : status === 400
                        ? "BAD_REQUEST"
                        : "INTERNAL_ERROR";

    if (status < 500) {
        logInfo("api_handled_error", getCorrelationId(req), {
            code,
            status,
            message: msg,
            operation: `${req.method} ${req.originalUrl}`,
        });
    }

    if (status >= 500) {
        void reportError({
            event: "api_unhandled_error",
            message: msg,
            correlationId: getCorrelationId(req),
            status,
            code,
            operation: `${req.method} ${req.originalUrl}`,
        });
    }

    return sendError(res, req, status, code, msg);
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", () => {
    logInfo("backend_listen", null, { url: `http://localhost:${PORT}` });
});
