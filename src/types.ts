// DB row types for new entities introduced in Sprint 1 (RC3 Campaign Evolution).
// Naming convention: *Row = shape of a raw Postgres result row.
// These types are used across services and routes; keep in sync with migrations.

// ─── campaigns ────────────────────────────────────────────────────────────────

export type CampaignDbStatus =
  | "reservations_open"
  | "reservations_closed"
  | "campaign_open"
  | "campaign_closed";

export type CampaignRow = {
  id: string;
  company_id: string;
  perimeter_id: string;
  status: CampaignDbStatus;
  reservations_opened_at: string | null;
  reservations_closed_at: string | null;
  campaign_opened_at: string | null;
  campaign_closed_at: string | null;
  reserved_users_count: number;
  total_applications_count: number;
  created_at: string;
};

// ─── campaign_applications_snapshot ───────────────────────────────────────────

export type CampaignApplicationsSnapshotRow = {
  id: string;
  campaign_id: string;
  company_id: string;
  perimeter_id: string;
  user_id: string;
  position_id: string;
  target_user_id: string | null;
  priority: number | null;
  original_created_at: string | null;
  snapshot_at: string;
};

// ─── organizational_units ─────────────────────────────────────────────────────

export type OrgUnitRow = {
  id: string;
  name: string;
  parent_id: string | null;
  level: number;
  company_id: string;
  perimeter_id: string;
  created_at: string;
};

/** @deprecated use OrgUnitRow */
export type DepartmentRow = OrgUnitRow;

// ─── hr_managers ──────────────────────────────────────────────────────────────

export type HrManagerRow = {
  id: string;
  company_id: string;
  perimeter_id: string;
  name: string;
  email: string | null;
  created_at: string;
};

// ─── responsabili ─────────────────────────────────────────────────────────────

export type ResponsabileRow = {
  id: string;
  company_id: string;
  perimeter_id: string;
  name: string;
  email: string | null;
  created_at: string;
};

// ─── user_hr_assignments ──────────────────────────────────────────────────────

export type UserHrAssignmentRow = {
  user_id: string;
  hr_manager_id: string;
  company_id: string;
  perimeter_id: string;
  created_at: string;
};

// ─── user_responsabile_assignments ────────────────────────────────────────────

export type UserResponsabileAssignmentRow = {
  user_id: string;
  responsabile_id: string;
  company_id: string;
  perimeter_id: string;
  created_at: string;
};

// ─── users (updated) ──────────────────────────────────────────────────────────
// Canonical shape of a users row. org_unit_id added RC3 (replaces department_id).

export type UserRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  role_id: string | null;
  location_id: string | null;
  org_unit_id: string | null;
  /** @deprecated use org_unit_id */
  department_id: string | null;
  company_id: string | null;
  perimeter_id: string | null;
  home_perimeter_id: string | null;
  availability_status: "available" | "inactive";
  is_reserved: boolean;
  fixed_location: boolean;
  application_count: number;
  show_position: boolean | null;
  created_at: string | null;
};
