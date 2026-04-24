import "dotenv/config";
import { pool } from "../src/db.js";

type CheckRow = {
    rule: string;
    violations: string;
    sample_ids: string[] | null;
};

const CHECKS_SQL = `
with checks as (
    select
        'users_without_role'::text as rule,
        count(*)::text as violations,
        coalesce(array_agg(u.id::text order by u.created_at desc) filter (where u.id is not null), '{}'::text[]) as sample_ids
    from users u
    where u.role_id is null

    union all

    select
        'applications_without_campaign_id'::text as rule,
        count(*)::text as violations,
        coalesce(array_agg(a.id::text order by a.created_at desc) filter (where a.id is not null), '{}'::text[]) as sample_ids
    from applications a
    where a.campaign_id is null

    union all

    select
        'scenarios_without_campaign_id'::text as rule,
        count(*)::text as violations,
        coalesce(array_agg(s.id::text order by s.created_at desc) filter (where s.id is not null), '{}'::text[]) as sample_ids
    from interlocking_scenarios s
    where s.campaign_id is null

    union all

    select
        'applications_cross_perimeter_user_mismatch'::text as rule,
        count(*)::text as violations,
        coalesce(array_agg(a.id::text order by a.created_at desc) filter (where a.id is not null), '{}'::text[]) as sample_ids
    from applications a
    join users u on u.id = a.user_id
    where a.company_id is distinct from u.company_id
       or a.perimeter_id is distinct from coalesce(u.perimeter_id, u.home_perimeter_id)

    union all

    select
        'applications_cross_perimeter_position_mismatch'::text as rule,
        count(*)::text as violations,
        coalesce(array_agg(a.id::text order by a.created_at desc) filter (where a.id is not null), '{}'::text[]) as sample_ids
    from applications a
    join positions p on p.id = a.position_id
    where a.company_id is distinct from p.company_id
       or a.perimeter_id is distinct from p.perimeter_id

    union all

    select
        'scenarios_campaign_scope_mismatch'::text as rule,
        count(*)::text as violations,
        coalesce(array_agg(s.id::text order by s.created_at desc) filter (where s.id is not null), '{}'::text[]) as sample_ids
    from interlocking_scenarios s
    join campaigns c on c.id = s.campaign_id
    where s.company_id is distinct from c.company_id
       or s.perimeter_id is distinct from c.perimeter_id
)
select
    rule,
    violations,
    case
        when cardinality(sample_ids) > 10 then sample_ids[1:10]
        else sample_ids
    end as sample_ids
from checks
order by rule asc;
`;

async function run() {
    const { rows } = await pool.query<CheckRow>(CHECKS_SQL);
    const failing = rows.filter((row) => Number(row.violations) > 0);

    console.log("JIP data integrity report");
    for (const row of rows) {
        const violations = Number(row.violations);
        const marker = violations > 0 ? "FAIL" : "OK";
        const sample = violations > 0 ? ` sample=${JSON.stringify(row.sample_ids ?? [])}` : "";
        console.log(` - [${marker}] ${row.rule}: ${violations}${sample}`);
    }

    if (failing.length > 0) {
        process.exitCode = 1;
    }
}

run()
    .catch((error) => {
        console.error("data_integrity_check_failed", error);
        process.exitCode = 2;
    })
    .finally(async () => {
        await pool.end().catch(() => undefined);
    });
