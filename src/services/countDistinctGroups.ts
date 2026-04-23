export type PositionGroupRow = {
  id: string;
  occupied_by: string | null;
};

export type OccupantGroupRow = {
  id: string;
  role_id: string | null;
  location_id: string | null;
  department_id: string | null;
};

/**
 * Counts distinct logical groups (role_id, location_id, department_id) for targeted positions.
 *
 * A logical group corresponds to the current occupant profile of each targeted position.
 * Missing positions/occupants are ignored.
 */
export function countDistinctGroups(params: {
  positionIds: Array<string | null | undefined>;
  positions: PositionGroupRow[];
  occupants: OccupantGroupRow[];
}): number {
  const targetPositionIds = new Set(
    params.positionIds.map((id) => String(id ?? "").trim()).filter(Boolean)
  );

  if (targetPositionIds.size === 0) return 0;

  const positionsById = new Map(params.positions.map((p) => [p.id, p]));
  const occupantsById = new Map(params.occupants.map((u) => [u.id, u]));

  const groups = new Set<string>();

  for (const positionId of targetPositionIds) {
    const position = positionsById.get(positionId);
    if (!position?.occupied_by) continue;

    const occupant = occupantsById.get(position.occupied_by);
    if (!occupant) continue;

    groups.add(`${occupant.role_id}__${occupant.location_id}__${occupant.department_id}`);
  }

  return groups.size;
}
