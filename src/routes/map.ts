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
        // requireAdmin è un middleware express (req,res,next)
        // lo invochiamo “inline” passando next finto che lancia
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

        // 2) viewer user (status + coords)
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


        // 3) applications del viewer (per usedPriorities e applied)
        const { data: myApplications, error: appsErr } = await supabaseAdmin
            .from("applications")
            .select("position_id, priority")
            .eq("user_id", viewerUserId);
        if (appsErr) throw appsErr;

        const usedPriorities = (myApplications ?? [])
            .map((a: { priority: number | null }) => a.priority)
            .filter((p: number | null): p is number => p != null);


        // 3b) RELAZIONI (replica PositionsMap: mode from/to)
        let relatedUserIds: string[] = [];
        const positionPriorityMap: Record<string, number> = {};

        if (mode === "from") {
            // io → posizioni a cui mi candido → occupanti di quelle posizioni
            const { data: apps, error } = await supabaseAdmin
                .from("applications")
                .select(`
      priority,
      positions (
        id,
        occupied_by
      )
    `)
                .eq("user_id", viewerUserId);

            if (error) throw error;

            relatedUserIds =
                (apps ?? [])
                    .map((a: any) => {
                        const pos = Array.isArray(a.positions) ? a.positions[0] : a.positions;
                        return pos?.occupied_by;
                    })
                    .filter(Boolean);

            (apps ?? []).forEach((a: any) => {
                const pos = Array.isArray(a.positions) ? a.positions[0] : a.positions;
                if (pos?.id && a.priority != null) {
                    positionPriorityMap[pos.id] = a.priority;
                }
            });


        } else {
            // altri → mie posizioni (positions.occupied_by = me)
            const { data: apps, error } = await supabaseAdmin
                .from("applications")
                .select(`
      user_id,
      priority,
      positions!inner (
        id,
        occupied_by
      )
    `)
                .eq("positions.occupied_by", viewerUserId);

            if (error) throw error;

            relatedUserIds = (apps ?? []).map((a: any) => a.user_id).filter(Boolean);

            (apps ?? []).forEach((a: any) => {
                const pos = Array.isArray(a.positions) ? a.positions[0] : a.positions;
                if (pos?.id && a.priority != null) {
                    positionPriorityMap[pos.id] = a.priority;
                }
            });

        }


        // 4) users + join positions + locations
        const { data: users, error: usersErr } = await supabaseAdmin
            .from("users")
            .select(`
    id,
    full_name,
    availability_status,
    position_id,
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
  `);

        if (usersErr) throw usersErr;


        // 5) aggregazione: byLocation -> roles -> users
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
            // Supabase join spesso torna array anche per 1:1
            const loc = Array.isArray((u as any).locations)
                ? (u as any).locations[0]
                : (u as any).locations;

            if (!loc) continue;

            // ruolo: lo prendiamo da role_id + roles.name
            const roleId = (u as any).role_id ?? "unknown";
            const roleName = (u as any).roles?.name ?? "—";



            // serve position_id dell'utente
            if (!u.position_id) continue;

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
                position_id: u.position_id,
            });

            // Replica FE: se questo utente è "relato" (from/to), allora applicazione attiva su quel role
            if (relatedUserIds.includes(u.id)) {
                byLocation[loc.id].roles[roleId].applied = true;

                if (byLocation[loc.id].roles[roleId].priority == null) {
                    const p = positionPriorityMap[u.position_id];
                    if (p != null) byLocation[loc.id].roles[roleId].priority = p;
                }
            }

        }

        const locations = Object.values(byLocation).map((loc) => ({
            ...loc,
            roles: Object.values(loc.roles),
        }));

        const OFFSET = 0.002;

        const locObj = Array.isArray((me as any).locations)
            ? (me as any).locations[0]
            : (me as any).locations;

        const lat = locObj?.latitude;
        const lng = locObj?.longitude;

        res.json({
            viewerUserId,
            myStatus:
                (me.availability_status ?? "inactive").toString().toLowerCase() === "available"
                    ? "available"
                    : "inactive",
            meLocation:
                lat != null && lng != null
                    ? { latitude: lat + OFFSET, longitude: lng + OFFSET }
                    : null,
            maxApplications: config.max_applications,
            usedPriorities: Array.from(new Set(usedPriorities)),
            locations,
        });

    } catch (err: any) {
        console.error("❌ map/positions error", err);
        res.status(500).json({ error: "MAP_POSITIONS_FAILED" });
    }
});
