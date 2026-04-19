import type { PoolClient } from "pg";

export type CampaignStatus = "open" | "closed";
export type ReservationStatus = "open" | "closed";
export type UserState = "inactive" | "reserved" | "available";

export type PerimeterLifecycle = {
  campaignStatus: CampaignStatus;
  reservationsStatus: ReservationStatus;
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

export async function loadPerimeterLifecycle(
  client: PoolClient,
  perimeterId: string,
  options?: { forUpdate?: boolean }
): Promise<PerimeterLifecycle | null> {
  const lockClause = options?.forUpdate ? " for update" : "";
  const { rows } = await client.query<{ campaign_status: string; reservations_status: string }>(
    `
    select campaign_status, reservations_status
    from perimeters
    where id = $1
    limit 1${lockClause}
    `,
    [perimeterId]
  );

  if (!rows.length) return null;

  return {
    campaignStatus: rows[0].campaign_status === "open" ? "open" : "closed",
    reservationsStatus: rows[0].reservations_status === "open" ? "open" : "closed",
  };
}

export function validateOpenReservations(lifecycle: PerimeterLifecycle): TransitionError | null {
  if (lifecycle.campaignStatus !== "closed") {
    return {
      status: 409,
      code: "RESERVATIONS_REQUIRE_CLOSED_CAMPAIGN",
      message: "Reservations can be opened only when campaign is closed",
    };
  }
  if (lifecycle.reservationsStatus === "open") {
    return {
      status: 409,
      code: "RESERVATIONS_ALREADY_OPEN",
      message: "Reservations are already open",
    };
  }
  return null;
}

export function validateCloseReservations(lifecycle: PerimeterLifecycle): TransitionError | null {
  if (lifecycle.reservationsStatus !== "open") {
    return {
      status: 409,
      code: "RESERVATIONS_NOT_OPEN",
      message: "Reservations can be closed only when they are open",
    };
  }
  return null;
}

export function validateOpenCampaign(lifecycle: PerimeterLifecycle): TransitionError | null {
  if (lifecycle.campaignStatus === "open") {
    return {
      status: 409,
      code: "CAMPAIGN_ALREADY_OPEN",
      message: "Campaign is already open",
    };
  }
  if (lifecycle.reservationsStatus !== "closed") {
    return {
      status: 409,
      code: "CAMPAIGN_REQUIRES_CLOSED_RESERVATIONS",
      message: "Campaign can be opened only after reservations are closed",
    };
  }
  return null;
}

export function validateCloseCampaign(lifecycle: PerimeterLifecycle): TransitionError | null {
  if (lifecycle.campaignStatus !== "open") {
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
    return {
      status: 409,
      code: "USER_ALREADY_RESERVED",
      message: "User is already reserved",
    };
  }

  if (action === "unreserve" && !isReserved) {
    return {
      status: 409,
      code: "USER_NOT_RESERVED",
      message: "User is not reserved",
    };
  }

  return null;
}
