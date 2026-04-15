export type IncomingApplicationRef = {
  id: string;
  user_id: string;
};

export type DeactivateCleanupPlan = {
  incomingApplicationIds: string[];
  affectedUserIds: string[];
};

/**
 * Builds the cleanup plan for incoming applications during user deactivation.
 *
 * - incomingApplicationIds: all incoming application rows to remove.
 * - affectedUserIds: distinct applicants impacted by the cleanup (excluding the deactivated user).
 */
export function planDeactivateCleanup(
  deactivatedUserId: string,
  incomingApplications: IncomingApplicationRef[]
): DeactivateCleanupPlan {
  const incomingApplicationIds: string[] = [];
  const affectedUserIds = new Set<string>();

  for (const row of incomingApplications) {
    incomingApplicationIds.push(row.id);
    if (row.user_id && row.user_id !== deactivatedUserId) {
      affectedUserIds.add(row.user_id);
    }
  }

  return {
    incomingApplicationIds,
    affectedUserIds: [...affectedUserIds],
  };
}
