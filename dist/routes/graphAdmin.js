import { Router } from "express";
import { pool } from "../db.js";
import { audit } from "../audit.js";
import { reportError } from "../observability.js";
export const graphAdminRouter = Router();
/**
 * POST /api/admin/graph/chains
 * RC1: calcolo catene (cicli) lato backend-api usando Postgres come SoT.
 * Output "compat": chains + optimalChains + summary.
 */
graphAdminRouter.post("/chains", async (req, res, next) => {
    const correlationId = req.correlationId ?? null;
    const actorId = req.user?.id ?? "unknown";
    try {
        const access = req.accessContext;
        if (!access?.currentCompanyId || !access?.currentPerimeterId) {
            return res.status(400).json({ ok: false, error: "PERIMETER_CONTEXT_REQUIRED", correlationId });
        }
        // 1) Build edges user_id -> target_user_id dal DB (applications + positions.occupied_by)
        const { rows } = await pool.query(`
  select
    a.user_id,
    a.position_id,
    p.occupied_by as target_user_id,
    coalesce(a.priority, 999) as priority
  from applications a
  join positions p on p.id = a.position_id
  where p.occupied_by is not null
    and a.user_id is not null
    and a.company_id = $1
    and a.perimeter_id = $2
    and p.company_id = $1
    and p.perimeter_id = $2
  `, [access.currentCompanyId, access.currentPerimeterId]);
        const edgePriority = new Map();
        for (const r of rows) {
            const u = String(r.user_id);
            const v = String(r.target_user_id);
            const p = Number(r.priority ?? 999);
            edgePriority.set(`${u}->${v}`, p);
        }
        const prioByEdge = new Map();
        for (const r of rows) {
            const u = String(r.user_id);
            const v = String(r.target_user_id);
            const p = Number(r.priority ?? 999);
            prioByEdge.set(`${u}->${v}`, p);
        }
        // Adjacency list: user -> [target...]
        const adj = new Map();
        for (const r of rows) {
            const u = String(r.user_id);
            const v = String(r.target_user_id);
            if (!adj.has(u))
                adj.set(u, []);
            adj.get(u).push(v);
        }
        // 2) Find simple cycles (Johnson-lite per digrafo con outdegree ridotto)
        // RC1 pragmatico: DFS da ogni nodo, limita lunghezza per evitare esplosione.
        const reqMax = Number(req.body?.maxLen ?? 8);
        const MAX_CYCLE_LEN = Number.isFinite(reqMax) ? Math.min(15, Math.max(2, reqMax)) : 8;
        const nodes = Array.from(adj.keys()).sort();
        const cycles = [];
        const seen = new Set(); // per dedup canonical key
        function canonKey(cycle) {
            // canonical rotation + direction (qui direzione fissa, ma normalizziamo rotazione)
            // esempio: [b,c,a] => [a,b,c]
            const n = cycle.length;
            let bestIdx = 0;
            for (let i = 1; i < n; i++) {
                if (cycle[i] < cycle[bestIdx])
                    bestIdx = i;
            }
            const rotated = cycle.slice(bestIdx).concat(cycle.slice(0, bestIdx));
            return rotated.join("->");
        }
        for (const start of nodes) {
            const stack = [];
            const onPath = new Set();
            const dfs = (u) => {
                if (stack.length >= MAX_CYCLE_LEN)
                    return;
                stack.push(u);
                onPath.add(u);
                const outs = adj.get(u) ?? [];
                for (const v of outs) {
                    if (v === start && stack.length >= 2) {
                        const cycle = stack.slice(); // chiude su start implicitamente
                        const key = canonKey(cycle);
                        if (!seen.has(key)) {
                            seen.add(key);
                            cycles.push(cycle);
                        }
                    }
                    else if (!onPath.has(v) && adj.has(v) && stack.length < MAX_CYCLE_LEN) {
                        dfs(v);
                    }
                }
                onPath.delete(u);
                stack.pop();
            };
            dfs(start);
        }
        // 3) Shape compatibile (minimo). "optimalChains" = placeholder (uguale a chains) per RC1.
        const chains = cycles.map((c) => {
            const ps = [];
            for (let i = 0; i < c.length; i++) {
                const u = c[i];
                const v = c[(i + 1) % c.length]; // chiusura ciclo
                const p = edgePriority.get(`${u}->${v}`) ?? 999;
                ps.push(p);
            }
            const avgPriority = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
            return {
                length: c.length,
                users: c,
                avgPriority,
            };
        });
        const allUserIds = Array.from(new Set(chains.flatMap((c) => c.users)));
        const { rows: userRows } = await pool.query(`
  select id, full_name
  from users
  where id = any($1)
    and company_id = $2
    and perimeter_id = $3
  `, [allUserIds, access.currentCompanyId, access.currentPerimeterId]);
        const usersById = Object.fromEntries(userRows.map((r) => [String(r.id), r.full_name ?? String(r.id)]));
        const enrichedChains = chains.map((c) => ({
            ...c,
            peopleNames: c.users.map((id) => usersById[id] ?? id),
        }));
        const summary = {
            edges: rows.length,
            nodes: nodes.length,
            chainsFound: enrichedChains.length,
            maxLen: MAX_CYCLE_LEN,
        };
        await audit("graph_chains_compute", actorId, {
            companyId: access.currentCompanyId,
            perimeterId: access.currentPerimeterId,
            maxLen: MAX_CYCLE_LEN,
        }, { ok: true, ...summary }, correlationId);
        return res.json({
            ok: true,
            summary,
            chains: enrichedChains,
            companyId: access.currentCompanyId,
            perimeterId: access.currentPerimeterId,
            correlationId,
        });
    }
    catch (e) {
        await reportError({
            event: "graph_chains_compute_failed",
            message: String(e?.message ?? e),
            correlationId,
            status: 500,
            code: "GRAPH_CHAINS_FAILED",
            operation: "graph_chains_compute",
        });
        await audit("graph_chains_compute", actorId, {}, { ok: false, error: String(e?.message ?? e) }, correlationId);
        next(e);
    }
});
//# sourceMappingURL=graphAdmin.js.map