import fs from "fs";
import path from "path";
import { Pool, PoolClient } from "pg";
import { createClient } from "@supabase/supabase-js";


const caPath = process.env.SUPABASE_DB_CA_PATH;

// NODE_ENV=production su Render. In locale spesso non è settato, quindi default = dev.
const isProd = process.env.NODE_ENV === "production";

const ssl =
    caPath && caPath.trim()
        ? { ca: fs.readFileSync(path.resolve(caPath), "utf8") }
        : { rejectUnauthorized: isProd }; // prod=true, dev=false

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
});


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
