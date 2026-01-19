import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { pool } from "./db.js"; // ✅ NO .js (evita risoluzioni ambigue in dev con tsx)

export function correlation(req: Request, _res: Response, next: NextFunction) {
    (req as any).correlationId =
        req.headers["x-correlation-id"] || crypto.randomUUID();
    next();
}

// ✅ Audit deve essere best-effort: mai buttare giù l’API se il log fallisce
export async function audit(
    action: string,
    adminUserId: string,
    payload: any,
    result: any,
    correlationId: string
) {
    try {
        await pool.query(
            `insert into admin_audit_log (ts, admin_user_id, action, payload_json, result_json, correlation_id)
             values (now(), $1, $2, $3::jsonb, $4::jsonb, $5)`,
            [
                adminUserId,
                action,
                JSON.stringify(payload ?? {}),
                JSON.stringify(result ?? {}),
                correlationId,
            ]
        );
    } catch (e: any) {
        // log locale: non throw
        console.error("AUDIT_FAILED", {
            action,
            adminUserId,
            correlationId,
            message: e?.message ?? String(e),
            code: e?.code,
        });
    }
}
