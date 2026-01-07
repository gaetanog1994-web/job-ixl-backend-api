import { createClient } from "@supabase/supabase-js";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});
if (!SUPABASE_URL)
    throw new Error("Missing SUPABASE_URL in backend-api/.env");
if (!SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in backend-api/.env");
export async function requireAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token)
            return res.status(401).json({ error: "Missing Bearer token" });
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user)
            return res.status(401).json({ error: "Invalid token" });
        req.user = { id: data.user.id, email: data.user.email ?? undefined };
        return next();
    }
    catch (e) {
        return res.status(500).json({ error: "Auth middleware failed" });
    }
}
export async function requireAdmin(req, res, next) {
    try {
        const r = req;
        const { data, error } = await supabaseAdmin
            .from("app_admins")
            .select("user_id")
            .eq("user_id", r.user.id)
            .maybeSingle();
        if (error)
            return res.status(500).json({ error: "RBAC check failed" });
        if (!data)
            return res.status(403).json({ error: "Admin only" });
        return next();
    }
    catch (e) {
        return res.status(500).json({ error: "Admin middleware failed" });
    }
}
//# sourceMappingURL=auth.js.map