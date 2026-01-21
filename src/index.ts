import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { requireAuth, requireAdmin, attachIsAdmin } from "./auth.js";
import { correlation } from "./audit.js";
import { adminRouter } from "./routes/admin.js";
import { graphProxyRouter } from "./routes/graphProxy.js";
import { pool } from "./db.js";
import { syncGraphRouter } from "./routes/syncGraph.js";
import { mapRouter } from "./routes/map.js";
import { applicationsRouter } from "./routes/applications.js";
import { usersRouter } from "./routes/users.js";




const app = express();
function getCorrelationId(req: any) {
    return req?.correlationId ?? null;
}

function sendError(res: any, req: any, status: number, code: string, message: string, extra?: any) {
    const correlationId = getCorrelationId(req);
    return res.status(status).json({
        ok: false,
        error: { code, message, ...(extra ? { extra } : {}) },
        correlationId,
    });
}

app.set("trust proxy", 1);

console.log("✅ BOOT BACKEND VERSION: BETA5");


app.use(express.json());
app.use(correlation);


// CORS (prima delle route)
app.use(
    cors({
        origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
            const allow = (process.env.CORS_ALLOWLIST ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);

            // server-to-server / curl / same-origin
            if (!origin) return cb(null, true);

            if (allow.includes(origin)) return cb(null, true);
            return cb(new Error("CORS blocked"), false);
        },
        credentials: true,
    })
);


// ✅ DOPO CORS
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/map", requireAuth, mapRouter);
app.use("/api", requireAuth, applicationsRouter);

app.get("/api/me", requireAuth, attachIsAdmin, (req, res) => {
    const r = req as any;
    res.json({
        user: r.user,
        isAdmin: r.isAdmin === true,
    });
});

// Health pubblico (no auth)
app.get("/health", async (_req: express.Request, res: express.Response) => {
    try {
        await pool.query("select 1");
        return res.status(200).json({ ok: true, correlationId: getCorrelationId(_req) });

    } catch (e: any) {
        console.error("HEALTH_DB_FAILED", {
            message: e?.message ?? String(e),
            code: e?.code,
        });
        return sendError(res, _req, 503, "DB_UNAVAILABLE", e?.message ?? String(e));

    }

});
app.get("/api/_debug/ping", (req, res) => {
    return res.json({ ok: true, ping: "pong", correlationId: getCorrelationId(req) });
});



// Rate limit solo admin (pulito, production-grade)
// NOTA: keyGenerator usa req.user.id -> quindi va messo DOPO requireAuth nello stack admin
const adminLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as any).user?.id ?? req.ip,
    handler: (req, res, _next, options) => {
        return sendError(res, req, options.statusCode, "RATE_LIMITED", "Too many requests");
    },
});




// ✅ Un solo "admin stack" senza duplicazioni
const adminApi = express.Router();

// Ordine importante:
// 1) requireAuth -> setta req.user
// 2) rateLimit -> usa req.user.id come key
// 3) requireAdmin -> RBAC app_admins
adminApi.use(requireAuth, adminLimiter, requireAdmin);

// rotte admin “normali”
adminApi.use("/", adminRouter);

// graph sync
adminApi.use("/sync-graph", syncGraphRouter);

// graph proxy (warmup/chains/...)
adminApi.use("/graph", graphProxyRouter);

// mount unico
app.use("/api/admin", adminApi);

if (process.env.NODE_ENV !== "production") {
    app.post("/_debug/auth-check", async (req: express.Request, res: express.Response) => {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token) return res.status(400).json({ ok: false, error: "Missing Bearer" });

        try {
            // import locale (evita circular)
            const { createClient } = await import("@supabase/supabase-js");
            const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
                auth: { persistSession: false, autoRefreshToken: false },
            });

            const { data, error } = await supabase.auth.getUser(token);
            return res.status(200).json({
                ok: !error,
                error: error?.message ?? null,
                user: data?.user ? { id: data.user.id, email: data.user.email } : null,
            });
        } catch (err: any) {
            console.error("❌ map/positions error FULL:", err);
            console.error("❌ message:", err?.message);
            console.error("❌ details:", err?.details);
            console.error("❌ hint:", err?.hint);
            console.error("❌ stack:", err?.stack);

            res.status(500).json({
                error: "MAP_POSITIONS_FAILED",
                message: err?.message ?? null,
            });
        }

    });
}

// 404 JSON (sempre)
app.use((req, res) => {
    return sendError(res, req, 404, "NOT_FOUND", "Route not found");
});

// Error handler globale (sempre JSON + correlationId)
app.use((err: any, req: any, res: any, _next: any) => {
    // Se headers già inviati, lascia fare a Express
    if (res.headersSent) return;

    const msg = String(err?.message ?? "Unknown error");

    // CORS
    if (msg === "CORS blocked") {
        return sendError(res, req, 403, "CORS_BLOCKED", "Origin not allowed");
    }

    // Rate limit (express-rate-limit usa spesso status 429)
    const status = Number(err?.status ?? err?.statusCode ?? 500);

    // Codici “standard”
    const code =
        status === 401 ? "UNAUTHORIZED" :
            status === 403 ? "FORBIDDEN" :
                status === 429 ? "RATE_LIMITED" :
                    status === 400 ? "BAD_REQUEST" :
                        "INTERNAL_ERROR";

    // Se vuoi loggare server-side (senza leak di token)
    console.error("API_ERROR", {
        code,
        status,
        message: msg,
        correlationId: getCorrelationId(req),
    });

    return sendError(res, req, status, code, msg);
});

// IMPORTANT: nessuna route pubblica tipo /api/graph

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend API up on http://localhost:${PORT}`);
});


