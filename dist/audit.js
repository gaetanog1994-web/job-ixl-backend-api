import { pool } from "./db.js";
import crypto from "crypto";
export function correlation(req, _res, next) {
    req.correlationId = req.headers["x-correlation-id"] || crypto.randomUUID();
    next();
}
export async function audit(action, adminUserId, payload, result, correlationId) {
    await pool.query(`insert into admin_audit_log (ts, admin_user_id, action, payload_json, result_json, correlation_id)
     values (now(), $1, $2, $3::jsonb, $4::jsonb, $5)`, [adminUserId, action, JSON.stringify(payload ?? {}), JSON.stringify(result ?? {}), correlationId]);
}
//# sourceMappingURL=audit.js.map