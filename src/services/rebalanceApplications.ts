export type RebalanceApplicationRow = {
  id: string;
  user_id: string;
  priority: number | null;
  created_at: string;
};

export type RebalancePlan = {
  deletedIds: string[];
  updates: Array<{ id: string; priority: number }>;
};

function byBusinessOrder(a: RebalanceApplicationRow, b: RebalanceApplicationRow): number {
  const aPriority = a.priority ?? Number.POSITIVE_INFINITY;
  const bPriority = b.priority ?? Number.POSITIVE_INFINITY;

  if (aPriority !== bPriority) return aPriority - bPriority;

  const aCreatedAt = new Date(a.created_at).getTime();
  const bCreatedAt = new Date(b.created_at).getTime();
  if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;

  return a.id.localeCompare(b.id);
}

/**
 * Produces a deterministic rebalance plan when max applications decreases.
 *
 * Rules per user:
 * 1) Keep first `newMax` applications by (priority ASC NULLS LAST, created_at ASC, id ASC).
 * 2) Delete the rest.
 * 3) Compact kept priorities to 1..N in the same order.
 */
export function rebalanceApplications(
  rows: RebalanceApplicationRow[],
  newMax: number
): RebalancePlan {
  if (!Number.isFinite(newMax) || newMax < 1) {
    throw new Error("newMax must be >= 1");
  }

  const byUser = new Map<string, RebalanceApplicationRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id);
    if (list) list.push(row);
    else byUser.set(row.user_id, [row]);
  }

  const deletedIds: string[] = [];
  const updates: Array<{ id: string; priority: number }> = [];

  for (const [, userRows] of byUser) {
    const ordered = [...userRows].sort(byBusinessOrder);
    const keep = ordered.slice(0, newMax);
    const drop = ordered.slice(newMax);

    for (const row of drop) {
      deletedIds.push(row.id);
    }

    for (let i = 0; i < keep.length; i++) {
      const targetPriority = i + 1;
      if (keep[i].priority !== targetPriority) {
        updates.push({ id: keep[i].id, priority: targetPriority });
      }
    }
  }

  return { deletedIds, updates };
}
