import { Router } from "express";
import { requireAuth } from "../auth.js";
import { supabaseAdmin } from "../db.js";
export const mapRouter = Router();
const MAP_CACHE_TTL_MS = Number(process.env.MAP_CACHE_TTL_MS ?? 15_000); // 15s default
const mapCache = new Map();
function cacheKey(params) {
    // include tokenUserId to avoid accidental cross-user leakage when viewerUserId omitted
    return `map:v2:${params.tokenUserId}:${params.viewerUserId}:${params.companyId}:${params.perimeterId}:${params.mode}`;
}
function cacheGet(key) {
    const hit = mapCache.get(key);
    if (!hit)
        return null;
    if (Date.now() > hit.expiresAt) {
        mapCache.delete(key);
        return null;
    }
    return hit.value;
}
function cacheSet(key, value) {
    mapCache.set(key, { value, expiresAt: Date.now() + MAP_CACHE_TTL_MS });
}
export function invalidateMapCache() {
    mapCache.clear();
}
/**
 * GET /api/map/positions
 * Query:
 *  - mode=from|to
 *  - viewerUserId? (admin only if != token user)
 */
mapRouter.get("/positions", requireAuth, async (req, res) => {
    const r = req;
    const tokenUserId = r.user.id;
    const viewerUserId = req.query.viewerUserId || tokenUserId;
    const mode = req.query.mode === "to" ? "to" : "from";
    const access = r.accessContext;
    if (!access?.currentCompanyId || !access?.currentPerimeterId) {
        return res.status(400).json({ error: "PERIMETER_CONTEXT_REQUIRED" });
    }
    // 🔐 Admin enforcement (se provo a vedere un altro user)
    if (viewerUserId !== tokenUserId) {
        if (!access.canManagePerimeter) {
            return res.status(403).json({ error: "PERIMETER_ADMIN_ONLY" });
        }
    }
    // ✅ Cache (solo dopo enforcement admin)
    const key = cacheKey({
        tokenUserId,
        viewerUserId,
        mode,
        companyId: access.currentCompanyId,
        perimeterId: access.currentPerimeterId,
    });
    const cached = cacheGet(key);
    if (cached) {
        return res.json(cached);
    }
    try {
        // 1) app_config
        const { data: config, error: configErr } = await supabaseAdmin
            .from("app_config")
            .select("max_applications")
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId)
            .single();
        if (configErr)
            throw configErr;
        // 2) viewer user (status + coords via locations)
        const { data: me, error: meErr } = await supabaseAdmin
            .from("users")
            .select(`
        id,
        role_id,
        availability_status,
        location_id,
        locations:location_id (
          latitude,
          longitude
        )
      `)
            .eq("id", viewerUserId)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId)
            .single();
        if (meErr)
            throw meErr;
        // 3) applications del viewer (per usedPriorities)
        const { data: myApplications, error: appsErr } = await supabaseAdmin
            .from("applications")
            .select("position_id, priority, company_id, perimeter_id")
            .eq("user_id", viewerUserId)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (appsErr)
            throw appsErr;
        const usedPriorities = (myApplications ?? [])
            .map((a) => a.priority)
            .filter((p) => p != null);
        /**
         * 3b) RELAZIONI from/to
         * - relatedUserIds: gli utenti da marcare come "applied" sulla mappa
         * - userPriorityMap: priorità da mostrare accanto al pallino rosso (per quell'utente)
         */
        let relatedUserIds = [];
        const userPriorityMap = {};
        if (mode === "from") {
            // io → posizioni a cui mi candido → occupanti di quelle posizioni
            const { data: apps, error } = await supabaseAdmin
                .from("applications")
                .select(`
                    position_id,
                    priority,
                    positions (
                        occupied_by
                    )
                `)
                .eq("user_id", viewerUserId)
                .eq("company_id", access.currentCompanyId)
                .eq("perimeter_id", access.currentPerimeterId);
            if (error)
                throw error;
            for (const a of apps ?? []) {
                const pos = Array.isArray(a.positions) ? a.positions[0] : a.positions;
                const occ = pos?.occupied_by;
                if (!occ)
                    continue;
                relatedUserIds.push(occ);
                // mettiamo la priorità migliore (min)
                if (a.priority != null) {
                    const prev = userPriorityMap[occ];
                    userPriorityMap[occ] = prev == null ? a.priority : Math.min(prev, a.priority);
                }
            }
        }
        else {
            // altri → mie posizioni (positions.occupied_by = me)
            // 1) trovo le mie posizioni
            const { data: myPos, error: myPosErr } = await supabaseAdmin
                .from("positions")
                .select("id")
                .eq("occupied_by", viewerUserId)
                .eq("company_id", access.currentCompanyId)
                .eq("perimeter_id", access.currentPerimeterId);
            if (myPosErr)
                throw myPosErr;
            const myPosIds = (myPos ?? []).map((p) => p.id).filter(Boolean);
            if (myPosIds.length > 0) {
                // 2) prendo le applications verso le mie posizioni
                const { data: apps, error } = await supabaseAdmin
                    .from("applications")
                    .select("user_id, position_id, priority")
                    .in("position_id", myPosIds)
                    .eq("company_id", access.currentCompanyId)
                    .eq("perimeter_id", access.currentPerimeterId);
                if (error)
                    throw error;
                for (const a of apps ?? []) {
                    if (!a.user_id)
                        continue;
                    relatedUserIds.push(a.user_id);
                    if (a.priority != null) {
                        const prev = userPriorityMap[a.user_id];
                        userPriorityMap[a.user_id] = prev == null ? a.priority : Math.min(prev, a.priority);
                    }
                }
            }
        }
        // dedup
        relatedUserIds = Array.from(new Set(relatedUserIds));
        /**
 * 4) POSITIONS “mappabili” (positions-first ✅)
 * Prendiamo le posizioni occupate e ci agganciamo all'utente occupante.
 * Così position_id è SEMPRE positions.id e non dipende da join inversi.
 */
        const { data: occupiedPositions, error: posErr } = await supabaseAdmin
            .from("positions")
            .select(`
      id,
      occupied_by,
      users:occupied_by (
        id,
        full_name,
        availability_status,
        role_id,
        roles:role_id (
          name
        ),
        location_id,
        locations:location_id (
          id,
          name,
          latitude,
          longitude
        )
      )
    `)
            .not("occupied_by", "is", null)
            .eq("company_id", access.currentCompanyId)
            .eq("perimeter_id", access.currentPerimeterId);
        if (posErr)
            throw posErr;
        // 5) aggregazione byLocation -> roles -> users
        const byLocation = {};
        for (const p of occupiedPositions ?? []) {
            // position_id reale e stabile
            const positionId = p.id;
            if (!positionId)
                continue;
            const u = p.users;
            if (!u)
                continue;
            const status = (u.availability_status ?? "").toString().toLowerCase();
            if (status !== "available")
                continue;
            const loc = Array.isArray(u.locations) ? u.locations[0] : u.locations;
            if (!loc)
                continue;
            const roleId = u.role_id ?? "unknown";
            const roleName = u.roles?.name ?? "—";
            // Regola business: nascondi posizioni con stesso ruolo + stessa sede del viewer.
            if (me?.role_id &&
                me?.location_id &&
                u.role_id === me.role_id &&
                u.location_id === me.location_id) {
                continue;
            }
            if (!byLocation[loc.id]) {
                byLocation[loc.id] = {
                    location_id: loc.id,
                    name: loc.name,
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    roles: {},
                };
            }
            if (!byLocation[loc.id].roles[roleId]) {
                byLocation[loc.id].roles[roleId] = {
                    role_id: roleId,
                    role_name: roleName,
                    applied: false,
                    priority: null,
                    users: [],
                };
            }
            byLocation[loc.id].roles[roleId].users.push({
                id: u.id,
                full_name: u.full_name,
                position_id: positionId, // ✅ SEMPRE positions.id
            });
            // applied/priority coerenti col mode (relatedUserIds contiene user_id)
            if (relatedUserIds.includes(u.id)) {
                byLocation[loc.id].roles[roleId].applied = true;
                const pBest = userPriorityMap[u.id];
                if (pBest != null) {
                    const prev = byLocation[loc.id].roles[roleId].priority;
                    byLocation[loc.id].roles[roleId].priority = prev == null ? pBest : Math.min(prev, pBest);
                }
            }
        }
        const locations = Object.values(byLocation).map((loc) => ({
            ...loc,
            roles: Object.values(loc.roles),
        }));
        // viewer marker
        const OFFSET = 0.002;
        const meLocObj = Array.isArray(me.locations) ? me.locations[0] : me.locations;
        const lat = meLocObj?.latitude;
        const lng = meLocObj?.longitude;
        const payload = {
            viewerUserId,
            viewerRoleId: me?.role_id ?? null,
            viewerLocationId: me?.location_id ?? null,
            myStatus: (me.availability_status ?? "inactive").toString().toLowerCase() === "available"
                ? "available"
                : "inactive",
            companyId: access.currentCompanyId,
            companyName: access.currentCompanyName,
            perimeterId: access.currentPerimeterId,
            perimeterName: access.currentPerimeterName,
            meLocation: lat != null && lng != null ? { latitude: lat + OFFSET, longitude: lng + OFFSET } : null,
            maxApplications: config.max_applications,
            usedPriorities: Array.from(new Set(usedPriorities)),
            locations,
        };
        cacheSet(key, payload);
        return res.json(payload);
    }
    catch (err) {
        console.error("❌ map/positions error", err);
        res.status(500).json({ error: "MAP_POSITIONS_FAILED" });
    }
});
//# sourceMappingURL=map.js.map