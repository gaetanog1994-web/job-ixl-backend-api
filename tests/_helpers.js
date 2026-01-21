import { createClient } from "@supabase/supabase-js";

export function getEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env ${name}`);
    return v;
}

export function makeSupabaseAnon() {
    return createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_ANON_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

export async function login(email, password) {
    const sb = makeSupabaseAnon();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const token = data?.session?.access_token;
    if (!token) throw new Error("No access token from signInWithPassword");
    return { sb, token, userId: data.session.user.id };
}

export async function apiFetch(path, token) {
    const base = getEnv("BASE_URL").replace(/\/+$/, "");
    const res = await fetch(`${base}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { }
    return { res, json, text };
}
