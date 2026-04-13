import { createClient } from "@supabase/supabase-js";
import { loadAccessContext, readRequestedContext } from "./tenant.js";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL)
    throw new Error("Missing SUPABASE_URL in backend-api/.env");
if (!SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in backend-api/.env");
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});
function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}
export async function requireAuth(req, _res, next) {
    try {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token)
            return next(httpError(401, "Missing Bearer token"));
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user)
            return next(httpError(401, "Invalid token"));
        req.user = { id: data.user.id, email: data.user.email ?? undefined };
        return next();
    }
    catch (e) {
        // non leakare dettagli
        return next(httpError(500, "Auth middleware failed"));
    }
}
export async function requireAdmin(req, _res, next) {
    try {
        const r = req;
        if (!r.accessContext) {
            const { requestedCompanyId, requestedPerimeterId } = readRequestedContext(req);
            r.accessContext = await loadAccessContext(r.user.id, requestedCompanyId, requestedPerimeterId);
        }
        if (!r.accessContext.canManagePerimeter)
            return next(httpError(403, "Admin only"));
        r.isAdmin = true;
        return next();
    }
    catch (e) {
        return next(httpError(500, "Admin middleware failed"));
    }
}
export async function attachIsAdmin(req, _res, next) {
    try {
        const r = req;
        if (!r.accessContext) {
            const { requestedCompanyId, requestedPerimeterId } = readRequestedContext(req);
            r.accessContext = await loadAccessContext(r.user.id, requestedCompanyId, requestedPerimeterId);
        }
        req.isAdmin = r.accessContext.canManagePerimeter === true;
        return next();
    }
    catch {
        req.isAdmin = false;
        return next();
    }
}
//# sourceMappingURL=auth.js.map