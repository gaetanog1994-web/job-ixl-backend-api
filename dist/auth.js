import { createClient } from "@supabase/supabase-js";
import { loadAccessContext, readRequestedContext } from "./tenant.js";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENABLE_TEST_AUTH_BYPASS = process.env.ENABLE_TEST_AUTH_BYPASS === "true";
if (!ENABLE_TEST_AUTH_BYPASS) {
    if (!SUPABASE_URL)
        throw new Error("Missing SUPABASE_URL in backend-api/.env");
    if (!SUPABASE_SERVICE_ROLE_KEY)
        throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in backend-api/.env");
}
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    })
    : null;
function httpError(status, message, code) {
    const e = new Error(message);
    e.status = status;
    if (code)
        e.code = code;
    return e;
}
export async function requireAuth(req, _res, next) {
    try {
        if (ENABLE_TEST_AUTH_BYPASS) {
            const testUserId = req.header("x-test-user-id")?.trim();
            if (testUserId) {
                const testUserEmail = req.header("x-test-user-email")?.trim() || undefined;
                req.user = { id: testUserId, email: testUserEmail };
                return next();
            }
        }
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token)
            return next(httpError(401, "Missing Bearer token"));
        if (!supabaseAdmin) {
            return next(httpError(500, "Auth middleware not configured"));
        }
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
export function requireAdmin(req, _res, next) {
    const r = req;
    // attachAccessContext must run before this middleware.
    if (!r.accessContext)
        return next(httpError(403, "Access context missing", "NO_ACCESS_CONTEXT"));
    if (!r.accessContext.canManagePerimeter)
        return next(httpError(403, "Admin only"));
    r.isAdmin = true;
    return next();
}
export async function attachIsAdmin(req, _res, next) {
    try {
        const r = req;
        if (!r.accessContext) {
            // attachAccessContext not in chain — load context here as fallback.
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