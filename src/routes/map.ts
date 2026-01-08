import { Router } from "express";
import { requireAuth, requireAdmin, type AuthedRequest } from "../auth.js";
import { supabaseAdmin } from "../db.js";

export const mapRouter = Router();

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
         * 4) USERS “mappabili”
         * Serve:
         * - role_id + roles.name
         * - location_id + locations(lat/lng)
         * - position_id = positions.id dove positions.occupied_by = users.id  ✅ (questa è la chiave!)
         */
        const { data: users, error: usersErr } = await supabaseAdmin
            .from("users")
            .select(
                `
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
        ),
        positions:positions!occupied_by (
          id
        )
      `
            );

        if (usersErr) throw usersErr;

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

        for (const u of users ?? []) {
            if (u.availability_status !== "available") continue;

            const loc = Array.isArray((u as any).locations) ? (u as any).locations[0] : (u as any).locations;
            if (!loc) continue;

            const roleId = (u as any).role_id ?? "unknown";
            const roleName = (u as any).roles?.name ?? "—";

            // posizione “occupata” dell’utente = positions.id (via FK positions.occupied_by)
            const posArr = (u as any).positions;
            const posObj = Array.isArray(posArr) ? posArr[0] : posArr;
            const positionId = posObj?.id;
            if (!positionId) continue; // senza positionId non posso candidarmi a lui

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
                position_id: positionId, // ✅ ADESSO è positions.id (corretto)
            });

            // applied/priority coerenti col mode
            if (relatedUserIds.includes(u.id)) {
                byLocation[loc.id].roles[roleId].applied = true;
                const p = userPriorityMap[u.id];
                if (p != null) byLocation[loc.id].roles[roleId].priority = p;
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

        res.json({
            viewerUserId,
            myStatus:
                (me.availability_status ?? "inactive").toString().toLowerCase() === "available"
                    ? "available"
                    : "inactive",
            meLocation: lat != null && lng != null ? { latitude: lat + OFFSET, longitude: lng + OFFSET } : null,
            maxApplications: config.max_applications,
            usedPriorities: Array.from(new Set(usedPriorities)),
            locations,
        });
    } catch (err: any) {
        console.error("❌ map/positions error", err);
        res.status(500).json({ error: "MAP_POSITIONS_FAILED" });
    }
});
