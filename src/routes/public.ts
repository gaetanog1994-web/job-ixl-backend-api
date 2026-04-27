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
 * GET /api/public/org-units
 * Hierarchical org units (flat list with parent_id) for current perimeter.
 * Authenticated users within current perimeter context.
 */
publicRouter.get("/org-units", requireAuth, attachAccessContext, requirePerimeterAccess, async (req, res, next) => {
    try {
        const access = (req as AuthedRequest).accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED" });
        }

        const { rows } = await pool.query(
            `
            select ou.id, ou.name, ou.parent_id, ou.level
            from organizational_units ou
            where ou.company_id = $1
              and ou.perimeter_id = $2
            order by ou.level asc, ou.name asc
            `,
            [access.currentCompanyId, access.currentPerimeterId]
        );

        return res.json({ ok: true, org_units: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});

/**
 * GET /api/public/departments
 * Backward compat alias for /api/public/org-units.
 */
publicRouter.get("/departments", requireAuth, attachAccessContext, requirePerimeterAccess, async (req, res, next) => {
    try {
        const access = (req as AuthedRequest).accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED" });
        }

        const { rows } = await pool.query(
            `
            select ou.id, ou.name, ou.parent_id, ou.level
            from organizational_units ou
            where ou.company_id = $1
              and ou.perimeter_id = $2
            order by ou.level asc, ou.name asc
            `,
            [access.currentCompanyId, access.currentPerimeterId]
        );

        return res.json({ ok: true, departments: rows, org_units: rows, correlationId: (req as any).correlationId ?? null });
    } catch (e) {
        next(e);
    }
});
