import type { Router } from "express";

import { pool, supabaseAdmin } from "../../src/db.js";

type ApplicationRow = {
  id: string;
  user_id: string;
  position_id: string;
  priority: number;
  company_id: string;
  perimeter_id: string;
};

type PositionRow = {
  id: string;
  occupied_by: string | null;
  company_id: string;
  perimeter_id: string;
};

type UserRow = {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  role_id?: string | null;
  location_id?: string | null;
  availability_status?: string;
  application_count?: number;
  company_id: string;
  perimeter_id?: string | null;
  home_perimeter_id?: string | null;
  show_position?: boolean;
};

type AppConfigRow = {
  singleton?: boolean;
  company_id: string;
  perimeter_id: string;
  max_applications: number;
};

type PerimeterRow = {
  id: string;
  campaign_status: "open" | "closed";
};

type CompanyMembershipRow = {
  company_id: string;
  user_id: string;
  role: string;
  status: string;
  created_by?: string;
};

type AuthUser = {
  id: string;
  email?: string | null;
};

export type DbState = {
  applications: ApplicationRow[];
  positions: PositionRow[];
  users: UserRow[];
  app_config: AppConfigRow[];
  perimeters: PerimeterRow[];
  company_memberships: CompanyMembershipRow[];
  authUsers: AuthUser[];
  invalidInviteEmails: Set<string>;
  auditRows: Array<{ action: string; payload: unknown; result: unknown }>;
  inviteCalls: number;
};

export function createDbState(seed?: Partial<DbState>): DbState {
  return {
    applications: seed?.applications ?? [],
    positions: seed?.positions ?? [],
    users: seed?.users ?? [],
    app_config: seed?.app_config ?? [],
    perimeters: seed?.perimeters ?? [],
    company_memberships: seed?.company_memberships ?? [],
    authUsers: seed?.authUsers ?? [],
    invalidInviteEmails: seed?.invalidInviteEmails ?? new Set<string>(),
    auditRows: seed?.auditRows ?? [],
    inviteCalls: seed?.inviteCalls ?? 0,
  };
}

type Filter =
  | { kind: "eq"; field: string; value: unknown }
  | { kind: "in"; field: string; values: unknown[] };

class SupabaseQueryBuilder {
  private operation: "select" | "update" | "delete" | "upsert" = "select";
  private updatePayload: Record<string, unknown> = {};
  private upsertRows: Record<string, unknown>[] = [];
  private readonly filters: Filter[] = [];
  private useSingle = false;

  constructor(private readonly table: keyof DbState, private readonly state: DbState) {}

  select(_columns: string) {
    this.operation = "select";
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.operation = "update";
    this.updatePayload = payload;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  upsert(rows: Record<string, unknown>[], _options?: Record<string, unknown>) {
    this.operation = "upsert";
    this.upsertRows = rows;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ kind: "eq", field, value });
    return this;
  }

  in(field: string, values: unknown[]) {
    this.filters.push({ kind: "in", field, values });
    return this;
  }

  async single() {
    this.useSingle = true;
    return this.execute();
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute() {
    const tableRows = this.state[this.table] as Record<string, unknown>[];
    const matching = tableRows.filter((row) => this.matches(row));

    if (this.operation === "select") {
      if (this.useSingle) {
        if (matching.length === 1) return { data: matching[0], error: null };
        if (matching.length === 0) return { data: null, error: { message: "No rows" } };
        return { data: null, error: { message: "Multiple rows" } };
      }
      return { data: matching, error: null };
    }

    if (this.operation === "update") {
      for (const row of matching) {
        Object.assign(row, this.updatePayload);
      }
      return { data: matching, error: null };
    }

    if (this.operation === "delete") {
      const retained = tableRows.filter((row) => !this.matches(row));
      (this.state[this.table] as Record<string, unknown>[]) = retained;
      return { data: null, error: null };
    }

    if (this.operation === "upsert") {
      if (this.table !== "applications") {
        throw new Error(`Unsupported upsert table in harness: ${String(this.table)}`);
      }

      for (const incoming of this.upsertRows) {
        const existing = this.state.applications.find(
          (row) => row.user_id === String(incoming.user_id) && row.position_id === String(incoming.position_id)
        );
        if (existing) {
          existing.priority = Number(incoming.priority);
          existing.company_id = String(incoming.company_id);
          existing.perimeter_id = String(incoming.perimeter_id);
        } else {
          this.state.applications.push({
            id: String(incoming.id ?? `app-${this.state.applications.length + 1}`),
            user_id: String(incoming.user_id),
            position_id: String(incoming.position_id),
            priority: Number(incoming.priority),
            company_id: String(incoming.company_id),
            perimeter_id: String(incoming.perimeter_id),
          });
        }
      }

      return { data: this.upsertRows, error: null };
    }

    throw new Error("Unsupported operation");
  }

  private matches(row: Record<string, unknown>) {
    return this.filters.every((filter) => {
      if (filter.kind === "eq") {
        return row[filter.field] === filter.value;
      }
      return filter.values.includes(row[filter.field]);
    });
  }
}

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function computeDistinctGroupsCount(state: DbState, userId: string, companyId: string, perimeterId: string) {
  const apps = state.applications.filter(
    (a) => a.user_id === userId && a.company_id === companyId && a.perimeter_id === perimeterId
  );
  const groups = new Set<string>();
  for (const app of apps) {
    const position = state.positions.find(
      (p) => p.id === app.position_id && p.company_id === companyId && p.perimeter_id === perimeterId
    );
    if (!position?.occupied_by) continue;
    const occupant = state.users.find((u) => u.id === position.occupied_by && u.company_id === companyId);
    if (!occupant) continue;
    groups.add(`${String(occupant.role_id ?? "")}__${String(occupant.location_id ?? "")}`);
  }
  return groups.size;
}

export function installDbHarness(state: DbState) {
  const originalPoolQuery = pool.query.bind(pool);
  const originalPoolConnect = pool.connect.bind(pool);
  const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
  const originalListUsers = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);
  const originalInvite = supabaseAdmin.auth.admin.inviteUserByEmail.bind(supabaseAdmin.auth.admin);

  (supabaseAdmin as any).from = (table: keyof DbState) => new SupabaseQueryBuilder(table, state);

  (supabaseAdmin.auth.admin as any).listUsers = async () => ({
    data: { users: [...state.authUsers] },
    error: null,
  });

  (supabaseAdmin.auth.admin as any).inviteUserByEmail = async (email: string) => {
    state.inviteCalls += 1;
    const normalized = String(email).trim().toLowerCase();
    if (state.invalidInviteEmails.has(normalized)) {
      return {
        data: null,
        error: { message: `Email address '${email}' is invalid` },
      };
    }

    const invited = {
      id: `invited-${state.inviteCalls}`,
      email: normalized,
    };
    state.authUsers.push(invited);
    return { data: { user: invited }, error: null };
  };

  (pool as any).query = async (sql: string, params: any[] = []) => {
    const nsql = normalizeSql(sql);

    if (nsql.startsWith("insert into admin_audit_log")) {
      state.auditRows.push({ action: String(params[1] ?? "unknown"), payload: params[2], result: params[3] });
      return { rows: [], rowCount: 1 };
    }

    if (nsql.startsWith("select campaign_status from perimeters where id = $1")) {
      const row = state.perimeters.find((p) => p.id === String(params[0]));
      return { rows: row ? [{ campaign_status: row.campaign_status }] : [], rowCount: row ? 1 : 0 };
    }

    if (nsql.startsWith("select max_applications from app_config")) {
      const row = state.app_config.find(
        (r) => r.company_id === String(params[0]) && r.perimeter_id === String(params[1])
      );
      return { rows: row ? [{ max_applications: row.max_applications }] : [], rowCount: row ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  (pool as any).connect = async () => {
    const client = {
      query: async (sql: string, params: any[] = []) => {
        const nsql = normalizeSql(sql);

        if (nsql === "begin" || nsql === "commit" || nsql === "rollback") {
          return { rows: [], rowCount: 0 };
        }

        if (nsql.startsWith("update applications set priority = $1")) {
          const [priority, appIds, targetUserId, companyId, perimeterId] = params as [number, string[], string, string, string];
          let affected = 0;
          for (const app of state.applications) {
            if (
              appIds.includes(app.id) &&
              app.user_id === targetUserId &&
              app.company_id === companyId &&
              app.perimeter_id === perimeterId
            ) {
              app.priority = priority;
              affected += 1;
            }
          }
          return { rows: [], rowCount: affected };
        }

        if (nsql.startsWith("delete from applications where user_id = $1")) {
          const [userId, companyId, perimeterId] = params as [string, string, string];
          const before = state.applications.length;
          state.applications = state.applications.filter(
            (a) => !(a.user_id === userId && a.company_id === companyId && a.perimeter_id === perimeterId)
          );
          return { rows: [], rowCount: before - state.applications.length };
        }

        if (nsql.startsWith("select a.id, a.user_id from applications a join positions p on p.id = a.position_id")) {
          const [userId, companyId, perimeterId] = params as [string, string, string];
          const rows = state.applications
            .filter((a) => a.company_id === companyId && a.perimeter_id === perimeterId)
            .filter((a) => {
              const pos = state.positions.find((p) => p.id === a.position_id);
              return pos?.occupied_by === userId;
            })
            .map((a) => ({ id: a.id, user_id: a.user_id }));
          return { rows, rowCount: rows.length };
        }

        if (nsql.startsWith("delete from applications where company_id = $1")) {
          const [companyId, perimeterId, ids] = params as [string, string, string[]];
          const before = state.applications.length;
          state.applications = state.applications.filter(
            (a) => !(a.company_id === companyId && a.perimeter_id === perimeterId && ids.includes(a.id))
          );
          return { rows: [], rowCount: before - state.applications.length };
        }

        if (nsql.startsWith("update users set availability_status = 'inactive'")) {
          const [userId, companyId, perimeterId] = params as [string, string, string];
          const user = state.users.find(
            (u) => u.id === userId && u.company_id === companyId && (u.perimeter_id ?? u.home_perimeter_id) === perimeterId
          );
          if (user) {
            user.availability_status = "inactive";
            user.application_count = 0;
            if (nsql.includes("show_position = false")) user.show_position = false;
          }
          return { rows: [], rowCount: user ? 1 : 0 };
        }

        if (nsql.startsWith("update users u set application_count = coalesce(x.cnt, 0)")) {
          const [affectedUserIds, companyId, perimeterId] = params as [string[], string, string];
          for (const userId of affectedUserIds) {
            const user = state.users.find((u) => u.id === userId && u.company_id === companyId);
            if (user) {
              user.application_count = computeDistinctGroupsCount(state, userId, companyId, perimeterId);
            }
          }
          return { rows: [], rowCount: affectedUserIds.length };
        }

        if (nsql.startsWith("update users set application_count = 0 where id = any($1)")) {
          const [affectedUserIds, companyId, perimeterId] = params as [string[], string, string];
          const activeUserIds = new Set(
            state.applications
              .filter((a) => a.company_id === companyId && a.perimeter_id === perimeterId)
              .map((a) => a.user_id)
          );
          let affected = 0;
          for (const userId of affectedUserIds) {
            if (activeUserIds.has(userId)) continue;
            const user = state.users.find((u) => u.id === userId && u.company_id === companyId);
            if (user) {
              user.application_count = 0;
              affected += 1;
            }
          }
          return { rows: [], rowCount: affected };
        }

        if (nsql.startsWith("insert into users (")) {
          const [id, email, firstName, lastName, fullName, companyId] = params as [
            string,
            string,
            string,
            string,
            string,
            string
          ];
          const existing = state.users.find((u) => u.id === id);
          if (existing) {
            existing.email = email;
            existing.first_name = firstName;
            existing.last_name = lastName;
            existing.full_name = fullName;
            existing.company_id = companyId;
          } else {
            state.users.push({
              id,
              email,
              first_name: firstName,
              last_name: lastName,
              full_name: fullName,
              availability_status: "inactive",
              application_count: 0,
              company_id: companyId,
            });
          }
          return { rows: [], rowCount: 1 };
        }

        if (nsql.startsWith("insert into company_memberships")) {
          const [companyId, userId, actorId] = params as [string, string, string];
          const existing = state.company_memberships.find(
            (m) => m.company_id === companyId && m.user_id === userId && m.role === "super_admin"
          );
          if (existing) {
            existing.status = "active";
            existing.created_by = actorId;
          } else {
            state.company_memberships.push({
              company_id: companyId,
              user_id: userId,
              role: "super_admin",
              status: "active",
              created_by: actorId,
            });
          }
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    return client;
  };

  return () => {
    (pool as any).query = originalPoolQuery;
    (pool as any).connect = originalPoolConnect;
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin.auth.admin as any).listUsers = originalListUsers;
    (supabaseAdmin.auth.admin as any).inviteUserByEmail = originalInvite;
  };
}

type MockResponse = {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  sent: boolean;
  status: (code: number) => MockResponse;
  json: (payload: any) => MockResponse;
  setHeader: (name: string, value: string) => void;
};

function makeResponse(): MockResponse {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    sent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      this.sent = true;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
  };
}

function findHandlers(router: Router, method: string, path: string) {
  const target = (router as any).stack.find((layer: any) => {
    return layer?.route?.path === path && layer?.route?.methods?.[method.toLowerCase()] === true;
  });

  if (!target) {
    throw new Error(`Route not found in harness: ${method.toUpperCase()} ${path}`);
  }

  return target.route.stack.map((entry: any) => entry.handle);
}

export async function invokeRoute(params: {
  router: Router;
  method: "get" | "post" | "delete" | "patch";
  path: string;
  req: any;
}) {
  const handlers = findHandlers(params.router, params.method, params.path);
  const req = params.req;
  const res = makeResponse();

  req.method = params.method.toUpperCase();
  req.path = req.path ?? pathToTestPath(params.path, req.params ?? {});
  req.originalUrl = req.originalUrl ?? req.path;
  req.query = req.query ?? {};
  req.body = req.body ?? {};
  req.headers = req.headers ?? {};
  req.header = (name: string) => req.headers[String(name).toLowerCase()];

  const dispatch = async (index: number, incomingError?: any): Promise<void> => {
    if (incomingError) {
      if (!res.sent) {
        res.status(Number(incomingError?.status ?? incomingError?.statusCode ?? 500)).json({
          ok: false,
          error: incomingError?.message ?? "Unhandled error",
          code: incomingError?.code ?? null,
        });
      }
      return;
    }

    if (index >= handlers.length || res.sent) return;

    await new Promise<void>((resolve, reject) => {
      let nextCalled = false;

      const next = (err?: any) => {
        nextCalled = true;
        void dispatch(index + 1, err).then(resolve).catch(reject);
      };

      try {
        const ret = handlers[index](req, res, next);
        Promise.resolve(ret)
          .then(() => {
            if (!nextCalled) resolve();
          })
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    }).catch(async (error) => {
      await dispatch(index + 1, error);
    });
  };

  await dispatch(0);
  return res;
}

function pathToTestPath(path: string, routeParams: Record<string, string>) {
  return path
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part;
      return routeParams[part.slice(1)] ?? part;
    })
    .join("/");
}
