// backend-api/src/routes/public.ts
import express from "express";
import { pool } from "../db.js";

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
