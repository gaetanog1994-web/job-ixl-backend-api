type PerimeterMembership = {
    perimeter_id?: string | null;
    company_id?: string | null;
    access_role?: string | null;
};

type AccessLike = {
    currentCompanyId?: string | null;
    currentPerimeterId?: string | null;
    perimeters?: PerimeterMembership[] | null;
};

export function isOperationalPerimeterAdmin(access: AccessLike | null | undefined): boolean {
    if (!access?.currentCompanyId || !access?.currentPerimeterId) return false;

    const directMemberships = Array.isArray(access.perimeters) ? access.perimeters : [];

    return directMemberships.some((membership) => {
        if (String(membership?.company_id ?? "") !== access.currentCompanyId) return false;
        if (String(membership?.perimeter_id ?? "") !== access.currentPerimeterId) return false;
        const role = String(membership?.access_role ?? "").toLowerCase();
        return role === "admin" || role === "admin_user";
    });
}
