import fs from "fs";
import path from "path";
import { Pool, PoolClient } from "pg";
import { createClient } from "@supabase/supabase-js";

type PoolLike = Pick<Pool, "query" | "connect">;

const caPath = process.env.SUPABASE_DB_CA_PATH;
const ENABLE_TEST_DB_BYPASS = process.env.ENABLE_TEST_DB_BYPASS === "true";

// NODE_ENV=production su Render. In locale spesso non è settato, quindi default = dev.
const isProd = process.env.NODE_ENV === "production";

const ssl =
    caPath && caPath.trim()
        ? {
            ca: fs.readFileSync(path.resolve(caPath), "utf8"),
            rejectUnauthorized: true,
        }
        : {
            // ✅ in dev: accetta chain non verificabile senza toccare TLS globale
            rejectUnauthorized: false,
        };


const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !ENABLE_TEST_DB_BYPASS) throw new Error("Missing DATABASE_URL");

let poolInternal: PoolLike;
if (DATABASE_URL) {
    // Parse URL per evitare che eventuali parametri SSL dentro la stringa sovrascrivano config
    const u = new URL(DATABASE_URL);
    poolInternal = new Pool({
        host: u.hostname,
        port: u.port ? Number(u.port) : 5432,
        database: u.pathname.replace(/^\//, "") || "postgres",
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        ssl, // ✅ qui ora è “source of truth”
    });
} else {
    // Test-only fallback: deterministic tests replace these methods with in-memory stubs.
    poolInternal = {
        query: async () => {
            throw new Error("DB pool not configured: set DATABASE_URL or provide test stub");
        },
        connect: async () => {
            throw new Error("DB pool not configured: set DATABASE_URL or provide test stub");
        },
    } as PoolLike;
}
export const pool = poolInternal;

console.log("DB ssl config:", ssl);
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("DATABASE_URL present:", !!process.env.DATABASE_URL);


export const supabaseAdmin = createClient(
    process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "test-service-role-key",
    { auth: { persistSession: false, autoRefreshToken: false } }
);

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
    } catch (e) {
        try { await client.query("ROLLBACK"); } catch { }
        throw e;
    } finally {
        client.release();
    }
}
