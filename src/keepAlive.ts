import { pool } from "./db.js";

const INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

export function startKeepAlive(): void {
    const appEnv = (process.env.APP_ENV ?? "development").toLowerCase();
    if (appEnv === "development") return;

    setInterval(async () => {
        try {
            await pool.query("SELECT 1");
            console.debug("[keep-alive] ping ok");
        } catch (err: any) {
            console.warn("[keep-alive] ping failed", err?.message ?? String(err));
        }
    }, INTERVAL_MS);
}
