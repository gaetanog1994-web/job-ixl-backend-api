import fs from "fs";
import path from "path";
import { Pool } from "pg";
const caPath = process.env.SUPABASE_DB_CA_PATH;
const ssl = caPath
    ? { ca: fs.readFileSync(path.resolve(caPath), "utf8") }
    : undefined;
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
});
export async function withTx(fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
    }
    catch (e) {
        try {
            await client.query("ROLLBACK");
        }
        catch { }
        throw e;
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=db.js.map