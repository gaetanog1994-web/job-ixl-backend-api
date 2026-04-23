// backend-api/src/routes/public.ts
import express from "express";
import { pool } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { attachAccessContext, requirePerimeterAccess } from "../tenant.js";

export const publicRouter = express.Router();

/**
 * GET /api/public/locations
 * Pubblico: serve a RegisterPage prima del login (no Bearer)
 */
publicRouter.get("/locations", async (_req, res, next) => {
    try {
        const { rows } = await pool.query(
            `select id, name from locations order by name asc limit 2000`
        );
        return res.json({ ok: true, locations: rows });
    } catch (e) {
        next(e);
    }
});

/**
 * GET /api/public/departments
 * Authenticated users within current perimeter context.
 */
publicRouter.get("/departments", requireAuth, attachAccessContext, requirePerimeterAccess, async (req, res, next) => {
    try {
        const access = (req as AuthedRequest).accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED" });
        }

        const { rows } = await pool.query(
            `
            select d.id, d.name
            from departments d
            where d.company_id = $1
              and d.perimeter_id = $2
            order by d.name asc
            `,
            [access.currentCompanyId, access.currentPerimeterId]
        );

        return res.json({ ok: true, departments: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});
