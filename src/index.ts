import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { correlation } from "./audit.js";
import { adminRouter } from "./routes/admin.js";
import { graphProxyRouter } from "./routes/graphProxy.js";
import { pool } from "./db.js";
import { syncGraphRouter } from "./routes/syncGraph.js";
import { mapRouter } from "./routes/map.js";
import { applicationsRouter } from "./routes/applications.js";
import { usersRouter } from "./routes/users.js";



const app = express();
app.set("trust proxy", 1);

console.log("✅ BOOT BACKEND VERSION: BETA5_DIST_REBUILD_TEST_001");


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
app.use("/api/map", mapRouter);
app.use("/api", applicationsRouter);


// Health pubblico (no auth)
app.get("/health", async (_req: express.Request, res: express.Response) => {
    try {
        await pool.query("select 1");
        return res.status(200).json({ ok: true });
    } catch {
        return res.status(503).json({ ok: false });
    }
});
app.get("/api/_debug/ping", (_req, res) => {
    res.json({ ok: true, ping: "pong" });
});


// Rate limit solo admin (1 volta sola, key = userId se disponibile)
const adminLimiter = rateLimit({
    windowMs: 60_000,
    max: 600, // ⬅️ TEMPORANEO
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as any).user?.id ?? req.ip,
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


// IMPORTANT: nessuna route pubblica tipo /api/graph

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend API up on http://localhost:${PORT}`);
});

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
