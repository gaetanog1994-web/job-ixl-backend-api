import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { withTx } from "../db.js";
import { audit } from "../audit.js";
import { invalidateMapCache } from "./map.js"; // aggiusta path corretto


// src/routes/users.ts
import express from "express";

import { pool } from "../db.js";

export const usersRouter = express.Router();

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


/**
 * POST /api/users/me/deactivate
 * Self-service: l'utente diventa "inactive" + cleanup delle sue applications
 */
usersRouter.post("/me/deactivate", requireAuth, async (req: Request, res: Response) => {
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
usersRouter.post("/me/activate", requireAuth, async (req: Request, res: Response) => {
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
