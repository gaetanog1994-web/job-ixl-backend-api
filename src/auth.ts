import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import type { AccessContext } from "./tenant.js";
import { loadAccessContext, readRequestedContext } from "./tenant.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL in backend-api/.env");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in backend-api/.env");

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

export type AuthedRequest = Request & {
    user: { id: string; email?: string };
    isAdmin?: boolean;
    accessContext?: AccessContext;
};


function httpError(status: number, message: string, code?: string) {
    const e: any = new Error(message);
    e.status = status;
    if (code) e.code = code;
    return e;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token) return next(httpError(401, "Missing Bearer token"));

        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) return next(httpError(401, "Invalid token"));

        (req as AuthedRequest).user = { id: data.user.id, email: data.user.email ?? undefined };
        return next();
    } catch (e: any) {
        // non leakare dettagli
        return next(httpError(500, "Auth middleware failed"));
    }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
    const r = req as AuthedRequest;
    // attachAccessContext must run before this middleware.
    if (!r.accessContext) return next(httpError(403, "Access context missing", "NO_ACCESS_CONTEXT"));
    if (!r.accessContext.canManagePerimeter) return next(httpError(403, "Admin only"));
    r.isAdmin = true;
    return next();
}

export async function attachIsAdmin(req: Request, _res: Response, next: NextFunction) {
    try {
        const r = req as AuthedRequest;
        if (!r.accessContext) {
            // attachAccessContext not in chain — load context here as fallback.
            const { requestedCompanyId, requestedPerimeterId } = readRequestedContext(req);
            r.accessContext = await loadAccessContext(r.user.id, requestedCompanyId, requestedPerimeterId);
        }
        (req as any).isAdmin = r.accessContext.canManagePerimeter === true;
        return next();
    } catch {
        (req as any).isAdmin = false;
        return next();
    }
}
