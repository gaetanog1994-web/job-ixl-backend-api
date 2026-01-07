import { Request, Response, NextFunction } from "express";
import { pool } from "../src/db.js";
import crypto from "crypto";

export function correlation(req: Request, _res: Response, next: NextFunction) {
    (req as any).correlationId = req.headers["x-correlation-id"] || crypto.randomUUID();
    next();
}

export async function audit(action: string, adminUserId: string, payload: any, result: any, correlationId: string) {
    await pool.query(
        `insert into admin_audit_log (ts, admin_user_id, action, payload_json, result_json, correlation_id)
     values (now(), $1, $2, $3::jsonb, $4::jsonb, $5)`,
        [adminUserId, action, JSON.stringify(payload ?? {}), JSON.stringify(result ?? {}), correlationId]
    );
}
