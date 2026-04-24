import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { pool } from "./db.js"; // ✅ NO .js (evita risoluzioni ambigue in dev con tsx)
import { reportError } from "./observability.js";

export function correlation(req: Request, res: Response, next: NextFunction) {
    const raw = req.headers["x-correlation-id"];
    const incoming = Array.isArray(raw) ? raw[0] : raw;
    const id = (incoming && String(incoming)) || crypto.randomUUID();

    (req as any).correlationId = id;

    // utile: torna sempre al client
    res.setHeader("x-correlation-id", id);

    next();
}


// ✅ Audit deve essere best-effort: mai buttare giù l’API se il log fallisce
type AuditScope = {
    companyId?: string | null;
    perimeterId?: string | null;
};

function readScopeFromObject(value: unknown): { company_id: string | null; perimeter_id: string | null } {
    if (!value || typeof value !== "object") {
        return { company_id: null, perimeter_id: null };
    }
    const source = value as Record<string, unknown>;
    const company =
        (typeof source.company_id === "string" && source.company_id) ||
        (typeof source.companyId === "string" && source.companyId) ||
        null;
    const perimeter =
        (typeof source.perimeter_id === "string" && source.perimeter_id) ||
        (typeof source.perimeterId === "string" && source.perimeterId) ||
        null;
    return { company_id: company, perimeter_id: perimeter };
}

export async function audit(
    action: string,
    adminUserId: string,
    payload: any,
    result: any,
    correlationId: string,
    scope?: AuditScope
) {
    try {
        const scopeFromPayload = readScopeFromObject(payload);
        const scopeFromResult = readScopeFromObject(result);
        const companyId =
            scope?.companyId ??
            scopeFromPayload.company_id ??
            scopeFromResult.company_id ??
            null;
        const perimeterId =
            scope?.perimeterId ??
            scopeFromPayload.perimeter_id ??
            scopeFromResult.perimeter_id ??
            null;
        const nowIso = new Date().toISOString();
        const auditEnvelope = {
            action,
            userId: adminUserId,
            input: payload ?? {},
            output: result ?? {},
            timestamp: nowIso,
            correlationId: correlationId ?? null,
            company_id: companyId,
            perimeter_id: perimeterId,
        };

        await pool.query(
            `insert into admin_audit_log (ts, admin_user_id, action, payload_json, result_json, correlation_id)
             values (now(), $1, $2, $3::jsonb, $4::jsonb, $5)`,
            [
                adminUserId,
                action,
                JSON.stringify(auditEnvelope),
                JSON.stringify({
                    output: result ?? {},
                    timestamp: nowIso,
                    company_id: companyId,
                    perimeter_id: perimeterId,
                }),
                correlationId,
            ]
        );
    } catch (e: any) {
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
