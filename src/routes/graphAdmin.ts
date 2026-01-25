import { Router } from "express";
import { pool } from "../db.js";

export const graphAdminRouter = Router();

/**
 * POST /api/admin/graph/chains
 * RC1: calcolo catene (cicli) lato backend-api usando Postgres come SoT.
 * Output "compat": chains + optimalChains + summary.
 */
graphAdminRouter.post("/chains", async (req, res, next) => {
    try {
        const correlationId = (req as any).correlationId ?? null;

        // 1) Build edges user_id -> target_user_id dal DB (applications + positions.occupied_by)
        const { rows } = await pool.query(
            `
  select
    a.user_id,
    a.position_id,
    p.occupied_by as target_user_id,
    coalesce(a.priority, 999) as priority
  from applications a
  join positions p on p.id = a.position_id
  where p.occupied_by is not null
    and a.user_id is not null
  `
        );

        const edgePriority = new Map<string, number>();

        for (const r of rows) {
            const u = String(r.user_id);
            const v = String(r.target_user_id);
            const p = Number(r.priority ?? 999);
            edgePriority.set(`${u}->${v}`, p);
        }


        const prioByEdge = new Map<string, number>();

        for (const r of rows as any[]) {
            const u = String(r.user_id);
            const v = String(r.target_user_id);
            const p = Number(r.priority ?? 999);
            prioByEdge.set(`${u}->${v}`, p);
        }


        // Adjacency list: user -> [target...]
        const adj = new Map<string, string[]>();
        for (const r of rows) {
            const u = String(r.user_id);
            const v = String(r.target_user_id);
            if (!adj.has(u)) adj.set(u, []);
            adj.get(u)!.push(v);
        }

        // 2) Find simple cycles (Johnson-lite per digrafo con outdegree ridotto)
        // RC1 pragmatico: DFS da ogni nodo, limita lunghezza per evitare esplosione.
        const reqMax = Number(req.body?.maxLen ?? 8);
        const MAX_CYCLE_LEN = Number.isFinite(reqMax) ? Math.min(15, Math.max(2, reqMax)) : 8;


        const nodes = Array.from(adj.keys()).sort();
        const cycles: string[][] = [];
        const seen = new Set<string>(); // per dedup canonical key

        function canonKey(cycle: string[]) {
            // canonical rotation + direction (qui direzione fissa, ma normalizziamo rotazione)
            // esempio: [b,c,a] => [a,b,c]
            const n = cycle.length;
            let bestIdx = 0;
            for (let i = 1; i < n; i++) {
                if (cycle[i] < cycle[bestIdx]) bestIdx = i;
            }
            const rotated = cycle.slice(bestIdx).concat(cycle.slice(0, bestIdx));
            return rotated.join("->");
        }

        for (const start of nodes) {
            const stack: string[] = [];
            const onPath = new Set<string>();

            const dfs = (u: string) => {
                if (stack.length >= MAX_CYCLE_LEN) return;

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
                    } else if (!onPath.has(v) && adj.has(v) && stack.length < MAX_CYCLE_LEN) {
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
            const ps: number[] = [];
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



        const allUserIds = Array.from(new Set(chains.flatMap((c: any) => c.users)));

        const { rows: userRows } = await pool.query(
            `
  select id, full_name
  from users
  where id = any($1)
  `,
            [allUserIds]
        );

        const usersById: Record<string, string> = Object.fromEntries(
            userRows.map((r: any) => [String(r.id), r.full_name ?? String(r.id)])
        );

        const enrichedChains = chains.map((c: any) => ({
            ...c,
            peopleNames: c.users.map((id: string) => usersById[id] ?? id),
        }));

        const summary = {
            edges: rows.length,
            nodes: nodes.length,
            chainsFound: enrichedChains.length,
            maxLen: MAX_CYCLE_LEN,
        };

        return res.json({
            ok: true,
            summary,
            chains: enrichedChains,
            correlationId,
        });


    } catch (e) {
        next(e);
    }
});
