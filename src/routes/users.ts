import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { withTx } from "../db.js";
import { audit } from "../audit.js";
import { invalidateMapCache } from "./map.js"; // aggiusta path corretto

export const usersRouter = Router();

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
             application_count = 0
         where id = $1
         returning id, availability_status`,
                [r.user.id]
            );

            return { userId: r.user.id, status: upd.rows?.[0]?.availability_status ?? "inactive" };
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
                set availability_status = 'available'
                where id = $1
                returning id, availability_status
                `,
                [r.user.id]
            );

            return { userId: r.user.id, status: upd.rows?.[0]?.availability_status ?? "available" };
        });

        invalidateMapCache(); // ✅ ESATTAMENTE QUI (come deactivate)

        await audit("user_activate_self", r.user.id, {}, out, correlationId);
        return res.status(200).json({ ok: true, out, correlationId });
    } catch (e: any) {
        await audit("user_activate_self", r.user.id, {}, { error: String(e?.message ?? e) }, correlationId);
        return res.status(500).json({ error: "Activate failed", correlationId });
    }
});
