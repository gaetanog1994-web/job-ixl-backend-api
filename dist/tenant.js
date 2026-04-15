import { pool } from "./db.js";
function httpError(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code ?? null;
    return error;
}
function asHeaderString(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function getHighestRole(input) {
    if (input.isOwner)
        return "owner";
    if (input.isCompanySuperAdmin)
        return "super_admin";
    if (input.canManagePerimeter)
        return "admin";
    if (input.canAccessPerimeter)
        return "user";
    return "guest";
}
export function readRequestedContext(req) {
    const requestedCompanyId = asHeaderString(req.header("x-company-id"));
    const requestedPerimeterId = asHeaderString(req.header("x-perimeter-id"));
    return { requestedCompanyId, requestedPerimeterId };
}
export async function loadAccessContext(userId, requestedCompanyId, requestedPerimeterId) {
    const [ownerRes, companyRes, perimeterRes, requestedPerimeterRes] = await Promise.all([
        pool.query(`
            select 1
            from owners
            where user_id = $1
            limit 1
            `, [userId]),
        pool.query(`
            select
              cm.company_id,
              c.name as company_name,
              c.slug,
              cm.role
            from company_memberships cm
            join companies c on c.id = cm.company_id
            where cm.user_id = $1
              and coalesce(cm.status, 'active') = 'active'
            order by c.name asc
            `, [userId]),
        pool.query(`
            select
              pm.perimeter_id,
              p.name as perimeter_name,
              p.slug as perimeter_slug,
              pm.company_id,
              c.name as company_name,
              pm.access_role
            from perimeter_memberships pm
            join perimeters p on p.id = pm.perimeter_id
            join companies c on c.id = pm.company_id
            where pm.user_id = $1
              and coalesce(pm.status, 'active') = 'active'
            order by c.name asc, p.name asc
            `, [userId]),
        requestedPerimeterId
            ? pool.query(`
                select
                  p.id as perimeter_id,
                  p.name as perimeter_name,
                  p.slug as perimeter_slug,
                  p.company_id,
                  c.name as company_name
                from perimeters p
                join companies c on c.id = p.company_id
                where p.id = $1
                limit 1
                `, [requestedPerimeterId])
            : Promise.resolve({ rows: [] }),
    ]);
    const isOwner = (ownerRes.rowCount ?? 0) > 0;
    const companies = companyRes.rows.map((row) => ({
        company_id: String(row.company_id),
        company_name: String(row.company_name),
        slug: String(row.slug ?? ""),
        role: row.role,
    }));
    const perimeters = perimeterRes.rows.map((row) => ({
        perimeter_id: String(row.perimeter_id),
        perimeter_name: String(row.perimeter_name),
        perimeter_slug: String(row.perimeter_slug ?? ""),
        company_id: String(row.company_id),
        company_name: String(row.company_name),
        access_role: row.access_role,
    }));
    const companyById = new Map(companies.map((company) => [company.company_id, company]));
    const perimeterById = new Map(perimeters.map((perimeter) => [perimeter.perimeter_id, perimeter]));
    const requestedPerimeter = requestedPerimeterRes.rows?.[0]
        ? {
            perimeter_id: String(requestedPerimeterRes.rows[0].perimeter_id),
            perimeter_name: String(requestedPerimeterRes.rows[0].perimeter_name),
            perimeter_slug: String(requestedPerimeterRes.rows[0].perimeter_slug ?? ""),
            company_id: String(requestedPerimeterRes.rows[0].company_id),
            company_name: String(requestedPerimeterRes.rows[0].company_name),
        }
        : null;
    const hasScopeMismatch = !!(requestedCompanyId &&
        requestedPerimeter &&
        requestedPerimeter.company_id !== requestedCompanyId);
    // Be resilient to stale frontend headers: if company and perimeter mismatch,
    // trust the perimeter's owning company and continue without hard-failing /api/me.
    let currentCompanyId = hasScopeMismatch
        ? requestedPerimeter?.company_id ?? requestedCompanyId
        : requestedCompanyId;
    let currentCompanyName = currentCompanyId
        ? companyById.get(currentCompanyId)?.company_name ?? requestedPerimeter?.company_name ?? null
        : null;
    let currentPerimeterId = requestedPerimeterId;
    let currentPerimeterName = requestedPerimeterId ? perimeterById.get(requestedPerimeterId)?.perimeter_name ?? requestedPerimeter?.perimeter_name ?? null : null;
    if (!currentCompanyId && requestedPerimeter?.company_id) {
        currentCompanyId = requestedPerimeter.company_id;
        currentCompanyName = requestedPerimeter.company_name;
    }
    if (!currentCompanyId && perimeters.length === 1) {
        currentCompanyId = perimeters[0].company_id;
        currentCompanyName = perimeters[0].company_name;
    }
    if (!currentCompanyId && companies.length === 1) {
        currentCompanyId = companies[0].company_id;
        currentCompanyName = companies[0].company_name;
    }
    if (!currentPerimeterId && perimeters.length === 1) {
        currentPerimeterId = perimeters[0].perimeter_id;
        currentPerimeterName = perimeters[0].perimeter_name;
        currentCompanyId = perimeters[0].company_id;
        currentCompanyName = perimeters[0].company_name;
    }
    const directPerimeterMembership = currentPerimeterId ? perimeterById.get(currentPerimeterId) ?? null : null;
    const canAccessCompany = isOwner ||
        (currentCompanyId ? companyById.has(currentCompanyId) : false) ||
        (currentCompanyId ? perimeters.some((perimeter) => perimeter.company_id === currentCompanyId) : false);
    const isCompanySuperAdmin = !!(currentCompanyId && (isOwner || companyById.has(currentCompanyId)));
    const canAccessPerimeter = !!(currentPerimeterId &&
        (isOwner ||
            directPerimeterMembership ||
            // Super admins of a company implicitly can access all perimeters of that company.
            // This is intentional: super_admin manages the company's entire perimeter structure.
            // If stricter isolation is needed in future, replace this with explicit perimeter membership check.
            (requestedPerimeter?.company_id && companyById.has(requestedPerimeter.company_id))));
    let accessRole = directPerimeterMembership?.access_role ?? null;
    if (!accessRole && currentPerimeterId && canAccessPerimeter && (isOwner || isCompanySuperAdmin)) {
        accessRole = "admin_user";
    }
    // currentPerimeterId is required as the first guard — canManagePerimeter is
    // always false when no perimeter is in scope, even for owner/super_admin.
    const canManagePerimeter = !!(currentPerimeterId &&
        canAccessPerimeter &&
        (isOwner ||
            isCompanySuperAdmin ||
            accessRole === "admin" ||
            accessRole === "admin_user"));
    const isPerimeterAdmin = canManagePerimeter;
    if (currentCompanyId && !currentCompanyName) {
        const companyMatch = companies.find((company) => company.company_id === currentCompanyId)
            ?? perimeters.find((perimeter) => perimeter.company_id === currentCompanyId);
        currentCompanyName = companyMatch?.company_name ?? requestedPerimeter?.company_name ?? null;
    }
    if (currentPerimeterId && !currentPerimeterName) {
        currentPerimeterName =
            directPerimeterMembership?.perimeter_name ??
                requestedPerimeter?.perimeter_name ??
                null;
    }
    return {
        requestedCompanyId,
        requestedPerimeterId,
        currentCompanyId,
        currentCompanyName,
        currentPerimeterId,
        currentPerimeterName,
        isOwner,
        isCompanySuperAdmin,
        isPerimeterAdmin,
        canAccessCompany,
        canAccessPerimeter,
        canManageCompany: isOwner || isCompanySuperAdmin,
        canManagePerimeter,
        accessRole,
        highestRole: getHighestRole({
            isOwner,
            isCompanySuperAdmin,
            canManagePerimeter,
            canAccessPerimeter,
        }),
        companies,
        perimeters,
    };
}
export async function attachAccessContext(req, _res, next) {
    try {
        const authedReq = req;
        const { requestedCompanyId, requestedPerimeterId } = readRequestedContext(req);
        authedReq.accessContext = await loadAccessContext(authedReq.user.id, requestedCompanyId, requestedPerimeterId);
        authedReq.isAdmin = authedReq.accessContext.canManagePerimeter;
        return next();
    }
    catch (error) {
        if (error?.status && error?.message) {
            return next(httpError(error.status, error.message, error.code));
        }
        return next(httpError(500, "Failed to resolve tenant access", "TENANT_CONTEXT_FAILED"));
    }
}
export function requireOwner(req, _res, next) {
    const access = req.accessContext;
    if (!access?.isOwner)
        return next(httpError(403, "Owner only", "OWNER_ONLY"));
    return next();
}
export function requireCompanyAdmin(req, _res, next) {
    const access = req.accessContext;
    if (!access?.currentCompanyId) {
        return next(httpError(400, "Company context required", "COMPANY_CONTEXT_REQUIRED"));
    }
    if (!access.canManageCompany) {
        return next(httpError(403, "Company admin only", "COMPANY_ADMIN_ONLY"));
    }
    return next();
}
export function requirePerimeterAccess(req, _res, next) {
    const access = req.accessContext;
    if (!access?.currentPerimeterId) {
        return next(httpError(400, "Perimeter context required", "PERIMETER_CONTEXT_REQUIRED"));
    }
    if (!access.canAccessPerimeter) {
        return next(httpError(403, "Perimeter access denied", "PERIMETER_ACCESS_DENIED"));
    }
    return next();
}
export function requirePerimeterAdmin(req, _res, next) {
    const access = req.accessContext;
    if (!access?.currentPerimeterId) {
        return next(httpError(400, "Perimeter context required", "PERIMETER_CONTEXT_REQUIRED"));
    }
    if (!access.canManagePerimeter) {
        return next(httpError(403, "Perimeter admin only", "PERIMETER_ADMIN_ONLY"));
    }
    return next();
}
export function requireTenantScope(req, _res, next) {
    const access = req.accessContext;
    if (!access?.currentCompanyId) {
        return next(httpError(400, "Company context required", "COMPANY_CONTEXT_REQUIRED"));
    }
    if (!access?.currentPerimeterId) {
        return next(httpError(400, "Perimeter context required", "PERIMETER_CONTEXT_REQUIRED"));
    }
    if (!access.canAccessPerimeter) {
        return next(httpError(403, "Perimeter access denied", "PERIMETER_ACCESS_DENIED"));
    }
    return next();
}
//# sourceMappingURL=tenant.js.map