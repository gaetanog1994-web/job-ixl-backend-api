import { Router } from "express";
import { pool, supabaseAdmin, withTx } from "../db.js";
import type { AuthedRequest } from "../auth.js";
import { requireCompanyAdmin, requireOwner } from "../tenant.js";
import { audit } from "../audit.js";

export const platformRouter = Router();

function splitName(firstName: string, lastName: string) {
    return `${firstName.trim()} ${lastName.trim()}`.replace(/\s+/g, " ").trim();
}

platformRouter.get("/companies", async (req, res, next) => {
    try {
        const access = (req as unknown as AuthedRequest).accessContext;
        if (access?.isOwner) {
            const { rows } = await pool.query(
                `
                select
                  c.id,
                  c.name,
                  c.slug,
                  c.status,
                  c.created_at,
                  count(distinct p.id)::int as perimeters_count,
                  count(distinct cm.user_id) filter (where cm.role = 'super_admin')::int as super_admins_count
                from companies c
                left join perimeters p on p.company_id = c.id
                left join company_memberships cm on cm.company_id = c.id and coalesce(cm.status, 'active') = 'active'
                group by c.id
                order by c.name asc
                `
            );
            return res.json({ ok: true, companies: rows, correlationId: (req as any).correlationId ?? null });
        }

        return res.json({
            ok: true,
            companies: access?.companies ?? [],
            correlationId: (req as any).correlationId ?? null,
        });
    } catch (error) {
        next(error);
    }
});

platformRouter.post("/companies", requireOwner, async (req, res, next) => {
    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId ?? null;

    try {
        const name = String(req.body?.name ?? "").trim();
        const firstName = String(req.body?.first_super_admin?.first_name ?? "").trim();
        const lastName = String(req.body?.first_super_admin?.last_name ?? "").trim();
        const email = String(req.body?.first_super_admin?.email ?? "").trim().toLowerCase();

        if (!name || !firstName || !lastName || !email) {
            return res.status(400).json({ ok: false, error: "missing company or super admin data", correlationId });
        }

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const fullName = splitName(firstName, lastName);

        const company = await withTx(async (client) => {
            const companyInsert = await client.query(
                `
                insert into companies (name, slug, status, created_by)
                values ($1, $2, 'active', $3)
                returning id, name, slug, status, created_at
                `,
                [name, slug || `company-${Date.now()}`, r.user.id]
            );

            const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
                data: {
                    first_name: firstName,
                    last_name: lastName,
                    full_name: fullName,
                },
            });

            if (error) throw new Error(error.message);
            const invitedUserId = data.user?.id;
            if (!invitedUserId) throw new Error("Invite returned no user id");

            const companyId = companyInsert.rows[0].id;

            await client.query(
                `
                insert into users (
                  id, email, first_name, last_name, full_name, availability_status,
                  application_count, company_id, created_by, updated_by
                )
                values ($1, $2, $3, $4, $5, 'inactive', 0, $6, $7, $7)
                on conflict (id) do update
                  set email = excluded.email,
                      first_name = excluded.first_name,
                      last_name = excluded.last_name,
                      full_name = excluded.full_name,
                      company_id = excluded.company_id,
                      updated_by = excluded.updated_by
                `,
                [invitedUserId, email, firstName, lastName, fullName, companyId, r.user.id]
            );

            await client.query(
                `
                insert into company_memberships (company_id, user_id, role, status, created_by)
                values ($1, $2, 'super_admin', 'active', $3)
                on conflict (company_id, user_id, role) do nothing
                `,
                [companyId, invitedUserId, r.user.id]
            );

            return {
                ...companyInsert.rows[0],
                first_super_admin: {
                    user_id: invitedUserId,
                    email,
                    first_name: firstName,
                    last_name: lastName,
                    full_name: fullName,
                },
            };
        });

        await audit("owner_create_company", r.user.id, { name, email }, company, correlationId);
        return res.status(201).json({ ok: true, company, correlationId });
    } catch (error) {
        next(error);
    }
});

platformRouter.patch("/companies/:companyId", requireCompanyAdmin, async (req, res, next) => {
    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId ?? null;

    try {
        const access = r.accessContext;
        const companyId = req.params.companyId;
        const name = String(req.body?.name ?? "").trim();

        if (!name) {
            return res.status(400).json({ ok: false, error: "missing company name", correlationId });
        }

        if (!access?.isOwner && access?.currentCompanyId !== companyId) {
            return res.status(403).json({
                ok: false,
                error: "Company scope mismatch",
                correlationId,
            });
        }

        const { rows } = await pool.query(
            `
            update companies
            set name = $1
            where id = $2
            returning id, name, slug, status, created_at
            `,
            [name, companyId]
        );

        if (!rows?.[0]) {
            return res.status(404).json({ ok: false, error: "Company not found", correlationId });
        }

        await audit("company_rename", r.user.id, { companyId, name }, { company: rows[0] }, correlationId);
        return res.json({ ok: true, company: rows[0], correlationId });
    } catch (error) {
        next(error);
    }
});

platformRouter.get("/companies/:companyId/perimeters", async (req, res, next) => {
    try {
        const access = (req as unknown as AuthedRequest).accessContext;
        const companyId = req.params.companyId;
        if (!access?.isOwner && !access?.companies.some((company) => company.company_id === companyId)) {
            return res.status(403).json({ ok: false, error: "Company access denied", correlationId: (req as any).correlationId ?? null });
        }

        const { rows } = await pool.query(
            `
            select
              p.id,
              p.company_id,
              p.name,
              p.slug,
              p.status,
              p.created_at,
              count(distinct pm.user_id)::int as members_count,
              count(distinct pm.user_id) filter (where pm.access_role in ('admin', 'admin_user'))::int as admins_count
            from perimeters p
            left join perimeter_memberships pm on pm.perimeter_id = p.id and coalesce(pm.status, 'active') = 'active'
            where p.company_id = $1
            group by p.id
            order by p.name asc
            `,
            [companyId]
        );

        return res.json({ ok: true, perimeters: rows, correlationId: (req as any).correlationId ?? null });
    } catch (error) {
        next(error);
    }
});

platformRouter.post("/companies/:companyId/perimeters", requireCompanyAdmin, async (req, res, next) => {
    const r = req as AuthedRequest;
    const correlationId = (req as any).correlationId ?? null;

    try {
        const access = r.accessContext;
        const companyId = req.params.companyId;
        if (!access?.isOwner && access?.currentCompanyId !== companyId) {
            return res.status(403).json({
                ok: false,
                error: "Company scope mismatch",
                correlationId,
            });
        }

        const name = String(req.body?.name ?? "").trim();
        if (!name) {
            return res.status(400).json({ ok: false, error: "missing perimeter name", correlationId });
        }

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const { rows } = await pool.query(
            `
            insert into perimeters (company_id, name, slug, status, created_by)
            values ($1, $2, $3, 'active', $4)
            returning id, company_id, name, slug, status, created_at
            `,
            [companyId, name, slug || `perimeter-${Date.now()}`, r.user.id]
        );

        const perimeter = rows[0];
        await audit("company_create_perimeter", r.user.id, { companyId, name }, { perimeter }, correlationId);
        return res.status(201).json({ ok: true, perimeter, correlationId });
    } catch (error) {
        next(error);
    }
});
