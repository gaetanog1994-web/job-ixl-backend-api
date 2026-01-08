import { Router } from "express";
import { requireAuth, requireAdmin, type AuthedRequest } from "../auth.js";
import { supabaseAdmin } from "../db.js";

export const applicationsRouter = Router();

/**
 * POST /api/users/:userId/applications/bulk
 * Body: { positionIds: string[], priority: number }
 *
 * RBAC:
 * - se :userId != token user => requireAdmin
 *
 * Regole:
 * - priority deve essere 1..max_applications (da app_config)
 * - positionIds dedup / non vuoto
 * - idempotenza "soft": se esistono già, non deve esplodere l'intero batch
 */
applicationsRouter.post("/users/:userId/applications/bulk", requireAuth, async (req, res) => {
    const r = req as AuthedRequest;

    const tokenUserId = r.user.id;
    const targetUserId = req.params.userId || tokenUserId;

    // 🔐 Admin enforcement se opero per un altro user
    if (targetUserId !== tokenUserId) {
        await new Promise<void>((resolve, reject) => {
            requireAdmin(r, res, (err?: any) => (err ? reject(err) : resolve()));
        });
    }

    try {
        const positionIdsRaw = req.body?.positionIds;
        const priorityRaw = req.body?.priority;

        const positionIds = Array.from(
            new Set(
                Array.isArray(positionIdsRaw)
                    ? positionIdsRaw.map((x: any) => String(x)).filter(Boolean)
                    : []
            )
        );

        const priority = Number(priorityRaw);

        if (!positionIds.length) {
            return res.status(400).json({ error: "INVALID_BODY", message: "positionIds must be a non-empty array" });
        }
        if (!Number.isFinite(priority)) {
            return res.status(400).json({ error: "INVALID_BODY", message: "priority must be a number" });
        }

        // max_applications da config
        const { data: config, error: configErr } = await supabaseAdmin
            .from("app_config")
            .select("max_applications")
            .single();
        if (configErr) throw configErr;

        const maxApplications = Number(config?.max_applications ?? 0);
        if (!maxApplications || maxApplications < 1) {
            return res.status(500).json({ error: "CONFIG_INVALID", message: "max_applications missing/invalid" });
        }

        if (priority < 1 || priority > maxApplications) {
            return res.status(400).json({
                error: "INVALID_PRIORITY",
                message: `priority must be between 1 and ${maxApplications}`,
            });
        }

        // Regola prodotto: una priority non può essere usata più di una volta dallo stesso utente
        const { data: used, error: usedErr } = await supabaseAdmin
            .from("applications")
            .select("id")
            .eq("user_id", targetUserId)
            .eq("priority", priority)
            .limit(1);

        if (usedErr) throw usedErr;

        if ((used ?? []).length > 0) {
            return res.status(400).json({
                error: "PRIORITY_ALREADY_USED",
                message: `priority ${priority} is already used by this user`,
            });
        }


        // Insert batch
        const rows = positionIds.map((position_id) => ({
            user_id: targetUserId,
            position_id,
            priority,
        }));

        const { error: insErr } = await supabaseAdmin.from("applications").insert(rows);
        if (insErr) {
            // idempotenza "soft": se ci sono duplicati e hai un vincolo unique, qui potrebbe esplodere.
            // Per ora: ritorniamo errore esplicito. (Se mi confermi unique(user_id, position_id),
            // nel prossimo step lo gestiamo con upsert/onConflict.)
            return res.status(409).json({ error: "INSERT_FAILED", message: insErr.message });
        }

        return res.status(200).json({ ok: true, inserted: rows.length });
    } catch (err: any) {
        console.error("❌ applications bulk insert error", err);
        return res.status(500).json({ error: "APPLICATIONS_BULK_INSERT_FAILED" });
    }
});

/**
 * DELETE /api/users/:userId/applications/bulk
 * Body: { positionIds: string[] }
 */
applicationsRouter.delete("/users/:userId/applications/bulk", requireAuth, async (req, res) => {
    const r = req as AuthedRequest;

    const tokenUserId = r.user.id;
    const targetUserId = req.params.userId || tokenUserId;

    // 🔐 Admin enforcement se opero per un altro user
    if (targetUserId !== tokenUserId) {
        await new Promise<void>((resolve, reject) => {
            requireAdmin(r, res, (err?: any) => (err ? reject(err) : resolve()));
        });
    }

    try {
        const positionIdsRaw = req.body?.positionIds;
        const positionIds = Array.from(
            new Set(
                Array.isArray(positionIdsRaw)
                    ? positionIdsRaw.map((x: any) => String(x)).filter(Boolean)
                    : []
            )
        );

        if (!positionIds.length) {
            return res.status(400).json({ error: "INVALID_BODY", message: "positionIds must be a non-empty array" });
        }

        const { error: delErr } = await supabaseAdmin
            .from("applications")
            .delete()
            .eq("user_id", targetUserId)
            .in("position_id", positionIds);

        if (delErr) throw delErr;

        return res.status(200).json({ ok: true, deleted: true });
    } catch (err: any) {
        console.error("❌ applications bulk delete error", err);
        return res.status(500).json({ error: "APPLICATIONS_BULK_DELETE_FAILED" });
    }
});
