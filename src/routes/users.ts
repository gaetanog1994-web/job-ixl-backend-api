import type { Router, Request, Response, NextFunction } from "express";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { pool, withTx } from "../db.js";
import { audit } from "../audit.js";
import { invalidateMapCache } from "./map.js"; // aggiusta path corretto


// src/routes/users.ts
import express from "express";

export const usersRouter = express.Router();

/**
 * POST /api/users/me/ensure
 * Crea/aggiorna la riga in public.users per l'utente loggato.
 * Serve dopo signUp/login per bootstrap profilo applicativo senza supabase.from nel FE.
 */
usersRouter.post("/me/ensure", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const r = req as AuthedRequest;
        const correlationId = (req as any).correlationId ?? null;

        const { full_name, location_id } = req.body ?? {};
        const fullName = String(full_name ?? "").trim();
        const locationId = location_id ? String(location_id) : null;

        if (!fullName) {
            const e: any = new Error("missing full_name");
            e.status = 400;
            throw e;
        }

        const { rows } = await pool.query(
            `
      insert into users (id, email, full_name, location_id, availability_status, application_count)
      values ($1, $2, $3, $4, 'inactive', 0)
      on conflict (id) do update
        set full_name = excluded.full_name,
            location_id = excluded.location_id
      returning id, email, full_name, location_id, availability_status, application_count
      `,
            [r.user.id, r.user.email ?? null, fullName, locationId]
        );

        invalidateMapCache();
        return res.json({ ok: true, user: rows[0], correlationId });
    } catch (err) {
        next(err);
    }
});


usersRouter.get("/me", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req as any).user?.id;
        if (!userId) {
            const e: any = new Error("Missing authed user");
            e.status = 401;
            throw e;
        }

        // Scegli SOLO i campi che vuoi esporre al FE
        const { rows } = await pool.query(
            `select
         id,
         email,
         availability_status,
         location_id,
         role_id,
         fixed_location
       from users
       where id = $1
       limit 1`,
            [userId]
        );

        if (!rows[0]) {
            const e: any = new Error("User row not found");
            e.status = 404;
            throw e;
        }

        return res.json({ ok: true, user: rows[0], correlationId: (req as any).correlationId ?? null });
    } catch (err) {
        next(err);
    }
});

// GET /api/users/me/applications
usersRouter.get("/me/applications", async (req, res, next) => {
    try {
        const userId = (req as any).user?.id;
        if (!userId) {
            const e: any = new Error("Missing authed user");
            e.status = 401;
            throw e;
        }

        const { rows } = await pool.query(
            `
      select
        a.id as app_id,
        a.position_id,
        a.priority,
        a.created_at,

        p.id as pos_id,
        p.occupied_by,

        ou.id as occ_user_id,
        ou.full_name as occ_full_name,
        ou.fixed_location as occ_fixed_location,

        r.name as occ_role_name,
        l.name as occ_location_name

      from applications a
      join positions p on p.id = a.position_id
      left join users ou on ou.id = p.occupied_by
      left join roles r on r.id = ou.role_id
      left join locations l on l.id = ou.location_id
      where a.user_id = $1
      order by a.priority asc, a.created_at asc
      `,
            [userId]
        );

        // ricostruiamo una shape compatibile con la vecchia select supabase (minimo necessario)
        const apps = rows.map((r) => ({
            id: r.app_id,
            position_id: r.position_id,
            priority: r.priority,
            created_at: r.created_at,
            positions: {
                id: r.pos_id,
                occupied_by: r.occupied_by,
                users: r.occ_user_id
                    ? {
                        id: r.occ_user_id,
                        full_name: r.occ_full_name,
                        fixed_location: r.occ_fixed_location,
                        roles: { name: r.occ_role_name ?? "—" },
                        locations: { name: r.occ_location_name ?? "—" },
                    }
                    : null,
            },
        }));

        return res.json({ ok: true, applications: apps, correlationId: (req as any).correlationId ?? null });
    } catch (err) {
        next(err);
    }
});

usersRouter.post("/me/ensure", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req as any).user?.id;
        if (!userId) {
            const e: any = new Error("Missing authed user");
            e.status = 401;
            throw e;
        }

        const { full_name, location_id } = req.body ?? {};
        if (!full_name || typeof full_name !== "string") {
            const e: any = new Error("Missing full_name");
            e.status = 400;
            throw e;
        }

        // upsert profilo applicativo
        const { rows } = await pool.query(
            `
      insert into users (id, full_name, location_id, availability_status, application_count)
      values ($1, $2, $3, 'inactive', 0)
      on conflict (id) do update
        set full_name = excluded.full_name,
            location_id = excluded.location_id
      returning id, email, full_name, location_id, availability_status, role_id, fixed_location
      `,
            [userId, full_name, location_id ?? null]
        );

        return res.json({ ok: true, user: rows[0], correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});


/**
 * POST /api/users/me/deactivate
 * Self-service: l'utente diventa "inactive" + cleanup delle sue applications
 */
usersRouter.post("/me/deactivate", async (req, res) => {

    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const out = await withTx(async (client) => {
            await client.query(`delete from applications where user_id = $1`, [r.user.id]);

            const upd = await client.query(
                `update users
                    set availability_status = 'inactive',
                        show_position = false,
                        application_count = 0
                    where id = $1
                    returning id, availability_status, show_position
                `,
                [r.user.id]
            );

            return {
                userId: r.user.id,
                status: upd.rows?.[0]?.availability_status ?? "inactive",
                showPosition: upd.rows?.[0]?.show_position ?? false,
            };

        });
        invalidateMapCache();
        await audit("user_deactivate_self", r.user.id, {}, out, correlationId);
        return res.status(200).json({ ok: true, out, correlationId });
    } catch (e: any) {
        await audit("user_deactivate_self", r.user.id, {}, { error: String(e?.message ?? e) }, correlationId);
        return res.status(500).json({ error: "Deactivate failed", correlationId });
    }
});


/**
 * POST /api/users/me/activate
 * Self-service: l'utente torna "available"
 */
usersRouter.post("/me/activate", async (req, res) => {

    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId;

    try {
        const out = await withTx(async (client) => {
            const upd = await client.query(
                `
                update users
                    set availability_status = 'available',
                        show_position = true
                    where id = $1
                    returning id, availability_status, show_position
                `,
                [r.user.id]
            );

            return {
                userId: r.user.id,
                status: upd.rows?.[0]?.availability_status ?? "available",
                showPosition: upd.rows?.[0]?.show_position ?? true,
            };

        });

        invalidateMapCache(); // ✅ ESATTAMENTE QUI (come deactivate)

        await audit("user_activate_self", r.user.id, {}, out, correlationId);
        return res.status(200).json({ ok: true, out, correlationId });
    } catch (e: any) {
        await audit("user_activate_self", r.user.id, {}, { error: String(e?.message ?? e) }, correlationId);
        return res.status(500).json({ error: "Activate failed", correlationId });
    }
});
