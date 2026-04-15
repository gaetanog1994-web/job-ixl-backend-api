type AuthUser = {
    id: string;
    email?: string | null;
};

type AuthAdminApi = {
    inviteUserByEmail: (
        email: string,
        options?: { data?: Record<string, unknown> }
    ) => Promise<{
        data: { user: AuthUser | null } | null;
        error: { message?: string | null } | null;
    }>;
    listUsers: (params?: { page?: number; perPage?: number }) => Promise<{
        data: { users: AuthUser[] } | null;
        error: { message?: string | null } | null;
    }>;
};

const MAX_LIST_USERS_PAGES = 50;
const LIST_USERS_PER_PAGE = 200;

export function normalizeEmailInput(input: unknown): string {
    let normalized = String(input ?? "").trim().toLowerCase();

    while (
        normalized.length >= 2 &&
        ((normalized.startsWith('"') && normalized.endsWith('"')) ||
            (normalized.startsWith("'") && normalized.endsWith("'")))
    ) {
        normalized = normalized.slice(1, -1).trim();
    }

    if (!normalized) {
        throw makeHttpError(400, "Email address is required");
    }

    return normalized;
}

export async function resolveAuthUserByEmail(
    authAdmin: AuthAdminApi,
    email: string
): Promise<AuthUser | null> {
    for (let page = 1; page <= MAX_LIST_USERS_PAGES; page += 1) {
        const { data, error } = await authAdmin.listUsers({
            page,
            perPage: LIST_USERS_PER_PAGE,
        });

        if (error) {
            throw new Error(error.message || "Unable to list auth users");
        }

        const users = data?.users ?? [];
        const existingUser = users.find(
            (user) => String(user.email ?? "").trim().toLowerCase() === email
        );

        if (existingUser) return existingUser;
        if (users.length < LIST_USERS_PER_PAGE) return null;
    }

    return null;
}

export async function getOrInviteUserByEmail(params: {
    authAdmin: AuthAdminApi;
    email: string;
    metadata?: Record<string, unknown>;
}): Promise<{ userId: string; source: "existing" | "invited" }> {
    const { authAdmin, email, metadata } = params;

    const existingUser = await resolveAuthUserByEmail(authAdmin, email);
    if (existingUser?.id) {
        return { userId: existingUser.id, source: "existing" };
    }

    const { data, error } = await authAdmin.inviteUserByEmail(email, {
        data: metadata,
    });

    if (error) {
        const resolvedAfterInviteError = await resolveAuthUserByEmail(authAdmin, email);
        if (resolvedAfterInviteError?.id) {
            return { userId: resolvedAfterInviteError.id, source: "existing" };
        }

        if (isInvalidEmailErrorMessage(error.message)) {
            throw makeHttpError(400, "Invalid email address");
        }

        throw new Error(error.message || "Unable to invite user");
    }

    const invitedUserId = data?.user?.id;
    if (invitedUserId) {
        return { userId: invitedUserId, source: "invited" };
    }

    const resolvedAfterInviteNoId = await resolveAuthUserByEmail(authAdmin, email);
    if (resolvedAfterInviteNoId?.id) {
        return { userId: resolvedAfterInviteNoId.id, source: "existing" };
    }

    throw new Error("Invite completed but returned no auth user id");
}

function isInvalidEmailErrorMessage(message: string | null | undefined): boolean {
    const normalized = String(message ?? "").toLowerCase();
    return normalized.includes("email") && normalized.includes("invalid");
}

function makeHttpError(status: number, message: string): Error & { status: number } {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    return error;
}
