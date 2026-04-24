import type { PoolClient } from "pg";
import { pool } from "../db.js";
import type { CampaignRow, CampaignDbStatus } from "../types.js";

export type CampaignStatus = "open" | "closed";
export type ReservationStatus = "open" | "closed";
export type UserState = "inactive" | "reserved" | "available";

export type PerimeterLifecycle = {
  campaignStatus: CampaignStatus;
  reservationsStatus: ReservationStatus;
  campaignId: string | null;
  campaignDbStatus: CampaignDbStatus | null;
};

export type TransitionError = {
  status: number;
  code: string;
  message: string;
};

export function deriveUserState(input: {
  availabilityStatus: string | null | undefined;
  isReserved: boolean | null | undefined;
}): UserState {
  const availability = String(input.availabilityStatus ?? "inactive").toLowerCase();
  if (availability === "available") return "available";
  if (Boolean(input.isReserved)) return "reserved";
  return "inactive";
}

function deriveLegacyLifecycle(row: CampaignRow | null): PerimeterLifecycle {
  if (!row) {
    return { campaignStatus: "closed", reservationsStatus: "closed", campaignId: null, campaignDbStatus: null };
  }
  const s = row.status;
  return {
    campaignId: row.id,
    campaignDbStatus: s,
    campaignStatus: s === "campaign_open" ? "open" : "closed",
    reservationsStatus: s === "reservations_open" ? "open" : "closed",
  };
}

async function fetchActiveCampaign(
  client: PoolClient,
  companyId: string,
  perimeterId: string,
  forUpdate: boolean
): Promise<CampaignRow | null> {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const { rows } = await client.query<CampaignRow>(
    `SELECT id, company_id, perimeter_id, status,
            reservations_opened_at, reservations_closed_at,
            campaign_opened_at, campaign_closed_at,
            reserved_users_count, total_applications_count, created_at
     FROM campaigns
     WHERE company_id = $1 AND perimeter_id = $2
       AND status != 'campaign_closed'
     ORDER BY created_at DESC
     LIMIT 1${lock}`,
    [companyId, perimeterId]
  );
  return rows[0] ?? null;
}

export async function loadCampaignLifecycle(
  client: PoolClient,
  companyId: string,
  perimeterId: string,
  options?: { forUpdate?: boolean }
): Promise<PerimeterLifecycle> {
  const row = await fetchActiveCampaign(client, companyId, perimeterId, options?.forUpdate ?? false);
  return deriveLegacyLifecycle(row);
}

export async function getCampaignStatus(
  companyId: string | null | undefined,
  perimeterId: string | null | undefined
): Promise<{ campaign_status: CampaignStatus; reservations_status: ReservationStatus; campaign_id: string | null }> {
  if (!companyId || !perimeterId) {
    return { campaign_status: "closed", reservations_status: "closed", campaign_id: null };
  }
  const { rows } = await pool.query<Pick<CampaignRow, "id" | "status">>(
    `SELECT id, status FROM campaigns
     WHERE company_id = $1 AND perimeter_id = $2
       AND status != 'campaign_closed'
     ORDER BY created_at DESC
     LIMIT 1`,
    [companyId, perimeterId]
  );
  const lc = deriveLegacyLifecycle((rows[0] as CampaignRow) ?? null);
  return {
    campaign_status: lc.campaignStatus,
    reservations_status: lc.reservationsStatus,
    campaign_id: lc.campaignId,
  };
}

export function validateOpenReservations(lifecycle: PerimeterLifecycle): TransitionError | null {
  const s = lifecycle.campaignDbStatus;
  if (s === "reservations_open") {
    return { status: 409, code: "RESERVATIONS_ALREADY_OPEN", message: "Reservations are already open" };
  }
  if (s === "reservations_closed" || s === "campaign_open") {
    return {
      status: 409,
      code: "RESERVATIONS_REQUIRE_CLOSED_CAMPAIGN",
      message: "Reservations can be opened only when campaign is closed",
    };
  }
  return null;
}

export function validateCloseReservations(lifecycle: PerimeterLifecycle): TransitionError | null {
  if (lifecycle.campaignDbStatus !== "reservations_open") {
    return {
      status: 409,
      code: "RESERVATIONS_NOT_OPEN",
      message: "Reservations can be closed only when they are open",
    };
  }
  return null;
}

export function validateOpenCampaign(lifecycle: PerimeterLifecycle): TransitionError | null {
  const s = lifecycle.campaignDbStatus;
  if (s === "campaign_open") {
    return { status: 409, code: "CAMPAIGN_ALREADY_OPEN", message: "Campaign is already open" };
  }
  if (s !== "reservations_closed") {
    return {
      status: 409,
      code: "CAMPAIGN_REQUIRES_CLOSED_RESERVATIONS",
      message: "Campaign can be opened only after reservations are closed",
    };
  }
  return null;
}

export function validateCloseCampaign(lifecycle: PerimeterLifecycle): TransitionError | null {
  if (lifecycle.campaignDbStatus !== "campaign_open") {
    return {
      status: 409,
      code: "CAMPAIGN_NOT_OPEN",
      message: "Campaign can be closed only when it is open",
    };
  }
  return null;
}

export function validateUserReservationAction(input: {
  lifecycle: PerimeterLifecycle;
  action: "reserve" | "unreserve";
  isReserved: boolean;
}): TransitionError | null {
  const { lifecycle, action, isReserved } = input;

  if (lifecycle.campaignStatus !== "closed") {
    return {
      status: 409,
      code: "RESERVATION_REQUIRES_CLOSED_CAMPAIGN",
      message: "Reservation can be modified only when campaign is closed",
    };
  }
  if (lifecycle.reservationsStatus !== "open") {
    return {
      status: 409,
      code: "RESERVATION_WINDOW_CLOSED",
      message: "Reservation can be modified only while reservation window is open",
    };
  }
  if (action === "reserve" && isReserved) {
    return { status: 409, code: "USER_ALREADY_RESERVED", message: "User is already reserved" };
  }
  if (action === "unreserve" && !isReserved) {
    return { status: 409, code: "USER_NOT_RESERVED", message: "User is not reserved" };
  }
  return null;
}

// ─── Service functions (execute inside a transaction) ────────────────────────

export async function openReservations(
  client: PoolClient,
  companyId: string,
  perimeterId: string
): Promise<{ campaign: CampaignRow } | { error: TransitionError }> {
  const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId, { forUpdate: true });
  const invalid = validateOpenReservations(lifecycle);
  if (invalid) return { error: invalid };

  const { rows } = await client.query<CampaignRow>(
    `INSERT INTO campaigns (company_id, perimeter_id, status, reservations_opened_at)
     VALUES ($1, $2, 'reservations_open', now())
     RETURNING *`,
    [companyId, perimeterId]
  );
  return { campaign: rows[0] };
}

export async function closeReservations(
  client: PoolClient,
  companyId: string,
  perimeterId: string
): Promise<{ campaign: CampaignRow } | { error: TransitionError }> {
  const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId, { forUpdate: true });
  const invalid = validateCloseReservations(lifecycle);
  if (invalid) return { error: invalid };

  const { rows } = await client.query<CampaignRow>(
    `UPDATE campaigns SET status = 'reservations_closed', reservations_closed_at = now()
     WHERE id = $1 RETURNING *`,
    [lifecycle.campaignId!]
  );
  return { campaign: rows[0] };
}

export async function openCampaign(
  client: PoolClient,
  companyId: string,
  perimeterId: string
): Promise<{ campaign: CampaignRow; usersUpdated: number } | { error: TransitionError }> {
  const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId, { forUpdate: true });
  const invalid = validateOpenCampaign(lifecycle);
  if (invalid) return { error: invalid };

  const countRes = await client.query<{ cnt: string }>(
    `SELECT count(*)::text as cnt FROM users
     WHERE company_id = $1 AND coalesce(perimeter_id, home_perimeter_id) = $2
       AND (coalesce(is_reserved, false) = true OR availability_status = 'available')`,
    [companyId, perimeterId]
  );
  const reservedCount = Number(countRes.rows[0]?.cnt ?? 0);

  const usersUpdate = await client.query(
    `UPDATE users
     SET availability_status = case when coalesce(is_reserved, false) then 'available' else 'inactive' end,
         show_position = case when coalesce(is_reserved, false) then true else false end
     WHERE company_id = $1 AND coalesce(perimeter_id, home_perimeter_id) = $2`,
    [companyId, perimeterId]
  );

  const { rows } = await client.query<CampaignRow>(
    `UPDATE campaigns SET status = 'campaign_open', campaign_opened_at = now(), reserved_users_count = $2
     WHERE id = $1 RETURNING *`,
    [lifecycle.campaignId!, reservedCount]
  );
  return { campaign: rows[0], usersUpdated: usersUpdate.rowCount ?? 0 };
}

export async function closeCampaign(
  client: PoolClient,
  companyId: string,
  perimeterId: string
): Promise<{
  campaign: CampaignRow;
  applicationsDeleted: number;
  usersReset: number;
  testScenarioUsersReset: number;
} | { error: TransitionError }> {
  const lifecycle = await loadCampaignLifecycle(client, companyId, perimeterId, { forUpdate: true });
  const invalid = validateCloseCampaign(lifecycle);
  if (invalid) return { error: invalid };

  const campaignId = lifecycle.campaignId!;

  const appCountRes = await client.query<{ cnt: string }>(
    `SELECT count(*)::text as cnt
     FROM applications
     WHERE company_id = $1
       AND perimeter_id = $2
       AND campaign_id = $3`,
    [companyId, perimeterId, campaignId]
  );
  const totalApplications = Number(appCountRes.rows[0]?.cnt ?? 0);

  await client.query(
    `INSERT INTO campaign_applications_snapshot
       (campaign_id, company_id, perimeter_id, user_id, position_id, target_user_id, priority, original_created_at)
     SELECT $1, a.company_id, a.perimeter_id, a.user_id, a.position_id,
            p.occupied_by, a.priority, a.created_at
     FROM applications a
     LEFT JOIN positions p ON p.id = a.position_id
     WHERE a.company_id = $2 AND a.perimeter_id = $3 AND a.campaign_id = $1`,
    [campaignId, companyId, perimeterId]
  );

  const deletedApplications = await client.query(
    `DELETE FROM applications WHERE company_id = $1 AND perimeter_id = $2 AND campaign_id = $3`,
    [companyId, perimeterId, campaignId]
  );

  const resetTestScenarioUsers = await client.query(
    `UPDATE users u
     SET availability_status = 'inactive',
         is_reserved = false,
         show_position = false
     WHERE u.company_id = $1
       AND coalesce(u.perimeter_id, u.home_perimeter_id) = $2
       AND EXISTS (
         SELECT 1
         FROM test_scenario_initialized_users tsiu
         WHERE tsiu.company_id = $1
           AND tsiu.perimeter_id = $2
           AND tsiu.campaign_id = $3
           AND tsiu.user_id = u.id
       )`,
    [companyId, perimeterId, campaignId]
  );

  await client.query(
    `DELETE FROM test_scenario_initialized_users
     WHERE company_id = $1
       AND perimeter_id = $2
       AND campaign_id = $3`,
    [companyId, perimeterId, campaignId]
  );

  const usersReset = await client.query(
    `UPDATE users
     SET availability_status = 'inactive', is_reserved = false, show_position = false, application_count = 0
     WHERE company_id = $1 AND coalesce(perimeter_id, home_perimeter_id) = $2`,
    [companyId, perimeterId]
  );

  const { rows } = await client.query<CampaignRow>(
    `UPDATE campaigns SET status = 'campaign_closed', campaign_closed_at = now(), total_applications_count = $2
     WHERE id = $1 RETURNING *`,
    [campaignId, totalApplications]
  );

  return {
    campaign: rows[0],
    applicationsDeleted: deletedApplications.rowCount ?? 0,
    usersReset: usersReset.rowCount ?? 0,
    testScenarioUsersReset: resetTestScenarioUsers.rowCount ?? 0,
  };
}
