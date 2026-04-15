import crypto from "crypto";
import { pool } from "./db.js"; // ✅ NO .js (evita risoluzioni ambigue in dev con tsx)
import { reportError } from "./observability.js";
export function correlation(req, res, next) {
    const raw = req.headers["x-correlation-id"];
    const incoming = Array.isArray(raw) ? raw[0] : raw;
    const id = (incoming && String(incoming)) || crypto.randomUUID();
    req.correlationId = id;
    // utile: torna sempre al client
    res.setHeader("x-correlation-id", id);
    next();
}
// ✅ Audit deve essere best-effort: mai buttare giù l’API se il log fallisce
export async function audit(action, adminUserId, payload, result, correlationId) {
    try {
        await pool.query(`insert into admin_audit_log (ts, admin_user_id, action, payload_json, result_json, correlation_id)
             values (now(), $1, $2, $3::jsonb, $4::jsonb, $5)`, [
            adminUserId,
            action,
            JSON.stringify(payload ?? {}),
            JSON.stringify(result ?? {}),
            correlationId,
        ]);
    }
    catch (e) {
        // log locale: non throw
        await reportError({
            event: "audit_write_failed",
            message: e?.message ?? String(e),
            correlationId,
            status: 500,
            code: e?.code ?? "AUDIT_FAILED",
            operation: action,
            meta: { adminUserId },
        });
    }
}
//# sourceMappingURL=audit.js.map