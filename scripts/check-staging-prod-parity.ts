import { Client } from "pg";

const TABLES = [
    "users",
    "applications",
    "roles",
    "campaigns",
    "interlocking_scenarios",
    "app_admins",
] as const;

type TableColumnRow = {
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
};

type PolicyRow = {
    tablename: string;
    policyname: string;
    permissive: string;
    roles: string[];
    cmd: string;
    qual: string | null;
    with_check: string | null;
};

type MigrationRow = {
    version: string;
};

async function readSnapshot(connectionString: string) {
    const client = new Client({ connectionString });
    await client.connect();
    try {
        const columns = await client.query<TableColumnRow>(
            `
            select table_name, column_name, data_type, is_nullable
            from information_schema.columns
            where table_schema = 'public'
              and table_name = any($1::text[])
            order by table_name, ordinal_position
            `,
            [TABLES]
        );

        const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
            `
            select c.relname, c.relrowsecurity
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relname = any($1::text[])
            order by c.relname
            `,
            [TABLES]
        );

        const policies = await client.query<PolicyRow>(
            `
            select tablename, policyname, permissive, roles, cmd, qual, with_check
            from pg_policies
            where schemaname = 'public'
              and tablename = any($1::text[])
            order by tablename, policyname
            `,
            [TABLES]
        );

        let migrations: MigrationRow[] = [];
        try {
            const migrationRes = await client.query<MigrationRow>(
                `
                select version
                from supabase_migrations.schema_migrations
                order by version asc
                `
            );
            migrations = migrationRes.rows;
        } catch {
            migrations = [];
        }

        return {
            columns: columns.rows,
            rls: rls.rows,
            policies: policies.rows,
            migrations,
        };
    } finally {
        await client.end();
    }
}

function toMap<T>(rows: T[], key: (row: T) => string) {
    const map = new Map<string, T>();
    for (const row of rows) map.set(key(row), row);
    return map;
}

function diffSets(label: string, left: string[], right: string[]) {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    const onlyLeft = left.filter((x) => !rightSet.has(x));
    const onlyRight = right.filter((x) => !leftSet.has(x));
    if (onlyLeft.length === 0 && onlyRight.length === 0) return [];
    return [
        `${label} mismatch`,
        ...(onlyLeft.length ? [`  only_staging: ${onlyLeft.join(", ")}`] : []),
        ...(onlyRight.length ? [`  only_prod: ${onlyRight.join(", ")}`] : []),
    ];
}

async function run() {
    const stagingUrl = process.env.STAGING_DATABASE_URL;
    const prodUrl = process.env.PROD_DATABASE_URL;
    if (!stagingUrl || !prodUrl) {
        throw new Error("Missing STAGING_DATABASE_URL or PROD_DATABASE_URL");
    }

    const [staging, prod] = await Promise.all([readSnapshot(stagingUrl), readSnapshot(prodUrl)]);
    const issues: string[] = [];

    const stagingColumns = staging.columns.map(
        (r) => `${r.table_name}:${r.column_name}:${r.data_type}:${r.is_nullable}`
    );
    const prodColumns = prod.columns.map(
        (r) => `${r.table_name}:${r.column_name}:${r.data_type}:${r.is_nullable}`
    );
    issues.push(...diffSets("table_columns", stagingColumns, prodColumns));

    const stagingRls = toMap(staging.rls, (row) => row.relname);
    const prodRls = toMap(prod.rls, (row) => row.relname);
    for (const table of TABLES) {
        const s = stagingRls.get(table)?.relrowsecurity ?? false;
        const p = prodRls.get(table)?.relrowsecurity ?? false;
        if (s !== p) {
            issues.push(`rls_enabled mismatch on ${table}: staging=${s} prod=${p}`);
        }
    }

    const stagingPolicies = staging.policies.map(
        (r) =>
            `${r.tablename}:${r.policyname}:${r.permissive}:${r.cmd}:${r.roles.join("|")}:${r.qual ?? ""}:${r.with_check ?? ""}`
    );
    const prodPolicies = prod.policies.map(
        (r) =>
            `${r.tablename}:${r.policyname}:${r.permissive}:${r.cmd}:${r.roles.join("|")}:${r.qual ?? ""}:${r.with_check ?? ""}`
    );
    issues.push(...diffSets("rls_policies", stagingPolicies, prodPolicies));

    if (staging.migrations.length > 0 || prod.migrations.length > 0) {
        issues.push(
            ...diffSets(
                "migrations",
                staging.migrations.map((m) => m.version),
                prod.migrations.map((m) => m.version)
            )
        );
    } else {
        console.warn("Migration table not readable in at least one environment; skipped migration parity check.");
    }

    console.log("Staging/Prod parity report");
    if (issues.length === 0) {
        console.log(" - OK: schema, RLS and policies aligned for required tables.");
        return;
    }

    for (const issue of issues) console.log(` - ${issue}`);
    process.exitCode = 1;
}

run().catch((error) => {
    console.error("check_staging_prod_parity_failed", error);
    process.exitCode = 2;
});
