import fs from "fs";
import path from "path";
import { Pool, PoolClient } from "pg";
import { createClient } from "@supabase/supabase-js";


const caPath = process.env.SUPABASE_DB_CA_PATH;

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
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");

// Parse URL per evitare che eventuali parametri SSL dentro la stringa sovrascrivano config
const u = new URL(DATABASE_URL);

export const pool = new Pool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database: u.pathname.replace(/^\//, "") || "postgres",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl, // ✅ qui ora è “source of truth”
});

console.log("DB ssl config:", ssl);
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("DATABASE_URL present:", !!process.env.DATABASE_URL);


export const supabaseAdmin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
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
