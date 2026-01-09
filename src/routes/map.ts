import { Router } from "express";
import { requireAuth, requireAdmin, type AuthedRequest } from "../auth.js";
import { supabaseAdmin } from "../db.js";

export const mapRouter = Router();
// --- Simple in-memory cache (product-lite) ---
type CacheEntry = { expiresAt: number; value: any };

const MAP_CACHE_TTL_MS = Number(process.env.MAP_CACHE_TTL_MS ?? 15_000); // 15s default
const mapCache = new Map<string, CacheEntry>();

function cacheKey(params: { tokenUserId: string; viewerUserId: string; mode: string }) {
    // include tokenUserId to avoid accidental cross-user leakage when viewerUserId omitted
    return `map:v1:${params.tokenUserId}:${params.viewerUserId}:${params.mode}`;
}

function cacheGet(key: string) {
    const hit = mapCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
        mapCache.delete(key);
        return null;
    }
    return hit.value;
}

function cacheSet(key: string, value: any) {
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
    const r = req as AuthedRequest;

    const tokenUserId = r.user.id;
    const viewerUserId = (req.query.viewerUserId as string) || tokenUserId;
    const mode = (req.query.mode as string) === "to" ? "to" : "from";

    // 🔐 Admin enforcement (se provo a vedere un altro user)
    if (viewerUserId !== tokenUserId) {
        await new Promise<void>((resolve, reject) => {
            requireAdmin(r, res, (err?: any) => (err ? reject(err) : resolve()));
        });
    }

    // ✅ Cache (solo dopo enforcement admin)
    const key = cacheKey({ tokenUserId, viewerUserId, mode });
    const cached = cacheGet(key);
    if (cached) {
        return res.json(cached);
    }

    try {
        // 1) app_config
        const { data: config, error: configErr } = await supabaseAdmin
            .from("app_config")
            .select("max_applications")
            .single();
        if (configErr) throw configErr;

        // 2) viewer user (status + coords via locations)
        const { data: me, error: meErr } = await supabaseAdmin
            .from("users")
            .select(
                `
        id,
        availability_status,
        location_id,
        locations:location_id (
          latitude,
          longitude
        )
      `
            )
            .eq("id", viewerUserId)
            .single();
        if (meErr) throw meErr;

        // 3) applications del viewer (per usedPriorities)
        const { data: myApplications, error: appsErr } = await supabaseAdmin
            .from("applications")
            .select("position_id, priority")
            .eq("user_id", viewerUserId);
        if (appsErr) throw appsErr;

        const usedPriorities = (myApplications ?? [])
            .map((a: { priority: number | null }) => a.priority)
            .filter((p: number | null): p is number => p != null);

        /**
         * 3b) RELAZIONI from/to
         * - relatedUserIds: gli utenti da marcare come "applied" sulla mappa
         * - userPriorityMap: priorità da mostrare accanto al pallino rosso (per quell'utente)
         */
        let relatedUserIds: string[] = [];
        const userPriorityMap: Record<string, number> = {};

        if (mode === "from") {
            // io → posizioni a cui mi candido → occupanti di quelle posizioni
            const { data: apps, error } = await supabaseAdmin
                .from("applications")
                .select(
                    `
                    position_id,
                    priority,
                    positions (
                        occupied_by
                    )
                `
                )
                .eq("user_id", viewerUserId);

            if (error) throw error;

            for (const a of apps ?? []) {
                const pos = Array.isArray((a as any).positions) ? (a as any).positions[0] : (a as any).positions;
                const occ = pos?.occupied_by;
                if (!occ) continue;

                relatedUserIds.push(occ);

                // mettiamo la priorità migliore (min)
                if (a.priority != null) {
                    const prev = userPriorityMap[occ];
                    userPriorityMap[occ] = prev == null ? a.priority : Math.min(prev, a.priority);
                }
            }
        } else {
            // altri → mie posizioni (positions.occupied_by = me)
            // 1) trovo le mie posizioni
            const { data: myPos, error: myPosErr } = await supabaseAdmin
                .from("positions")
                .select("id")
                .eq("occupied_by", viewerUserId);

            if (myPosErr) throw myPosErr;

            const myPosIds = (myPos ?? []).map((p: any) => p.id).filter(Boolean);

            if (myPosIds.length > 0) {
                // 2) prendo le applications verso le mie posizioni
                const { data: apps, error } = await supabaseAdmin
                    .from("applications")
                    .select("user_id, position_id, priority")
                    .in("position_id", myPosIds);

                if (error) throw error;

                for (const a of apps ?? []) {
                    if (!a.user_id) continue;
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
            .select(
                `
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
    `
            )
            .not("occupied_by", "is", null);

        if (posErr) throw posErr;


        // 5) aggregazione byLocation -> roles -> users
        const byLocation: Record<
            string,
            {
                location_id: string;
                name: string;
                latitude: number;
                longitude: number;
                roles: Record<
                    string,
                    {
                        role_id: string;
                        role_name: string;
                        applied: boolean;
                        priority: number | null;
                        users: Array<{ id: string; full_name: string; position_id: string }>;
                    }
                >;
            }
        > = {};

        for (const p of occupiedPositions ?? []) {
            // position_id reale e stabile
            const positionId = (p as any).id;
            if (!positionId) continue;

            const u = (p as any).users;
            if (!u) continue;

            const status = (u.availability_status ?? "").toString().toLowerCase();
            if (status !== "available") continue;

            const loc = Array.isArray((u as any).locations) ? (u as any).locations[0] : (u as any).locations;
            if (!loc) continue;

            const roleId = (u as any).role_id ?? "unknown";
            const roleName = (u as any).roles?.name ?? "—";

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
        const meLocObj = Array.isArray((me as any).locations) ? (me as any).locations[0] : (me as any).locations;
        const lat = meLocObj?.latitude;
        const lng = meLocObj?.longitude;

        const payload = {
            viewerUserId,
            myStatus:
                (me.availability_status ?? "inactive").toString().toLowerCase() === "available"
                    ? "available"
                    : "inactive",
            meLocation: lat != null && lng != null ? { latitude: lat + OFFSET, longitude: lng + OFFSET } : null,
            maxApplications: config.max_applications,
            usedPriorities: Array.from(new Set(usedPriorities)),
            locations,
        };

        cacheSet(key, payload);
        return res.json(payload);

    } catch (err: any) {
        console.error("❌ map/positions error", err);
        res.status(500).json({ error: "MAP_POSITIONS_FAILED" });
    }
});

