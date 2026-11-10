import "server-only";

import { getTranslations } from "next-intl/server";

import { storedDevice, type DeviceDescription } from "@/auth/sessions";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import {
  ACTIVITY_ACTORS,
  ACTIVITY_CATEGORIES,
  ACTIVITY_OUTCOMES,
  isActivityKind,
  isRoleCode,
  kindKey,
  type ActivityActor,
  type ActivityCategory,
  type ActivityKind,
  type ActivityOutcome,
  type RoleCode,
} from "./catalogue";
import { activityQuery, type ActivityCursor, type ActivityFilters } from "./filters";

/** How many entries one page shows. */
export const ACTIVITY_PAGE_SIZE = 25;

export type Loaded<T> =
  { readonly status: "ok"; readonly value: T } | { readonly status: "unavailable" };

/** One entry of the person's own history, as the pages show it. */
export interface ActivityEntryView {
  readonly id: string;
  readonly category: ActivityCategory;
  readonly kind: ActivityKind;
  readonly outcome: ActivityOutcome;
  /** The Home's name when the entry was recorded (people may have left since). */
  readonly homeName: string | null;
  readonly isCurrentMember: boolean;
  readonly actor: ActivityActor;
  /** Role changes only. */
  readonly roles: { readonly from: RoleCode; readonly to: RoleCode } | null;
  readonly device: DeviceDescription | null;
  readonly isCurrentSession: boolean;
  /** Sign-ins: whether that session is still signed in (then "Secure my account" can end it). */
  readonly sessionLive: boolean;
  readonly alerted: boolean;
  readonly response: "confirmed" | "reported" | null;
  readonly createdAt: string;
}

export interface ActivityPage {
  readonly entries: readonly ActivityEntryView[];
  /** Set when an older page may exist. */
  readonly next: ActivityCursor | null;
}

function logFailure(event: string, code: string | undefined): void {
  // Privacy-safe: the error code only, no account id.
  console.error(JSON.stringify({ event, code: code ?? null }));
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function rolesOf(details: unknown): ActivityEntryView["roles"] {
  if (typeof details !== "object" || details === null) return null;
  const { from, to } = details as Record<string, unknown>;
  return isRoleCode(from) && isRoleCode(to) ? { from, to } : null;
}

/** The person's own history, newest first, one page at a time. */
export async function listMyActivity(input: {
  readonly filters: ActivityFilters;
  readonly cursor: ActivityCursor | null;
  readonly timeZone: string;
  readonly scope?: ActivityCategory;
}): Promise<Loaded<ActivityPage>> {
  const t = await getTranslations("Activity");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "list_my_activity",
    activityQuery({
      ...input,
      labelOf: (kind) => t(kindKey(kind)),
      // One more than shown, to know whether an older page exists.
      limit: ACTIVITY_PAGE_SIZE + 1,
    }),
  );
  if (error) {
    logFailure("activity.list_failed", error.code);
    return { status: "unavailable" };
  }
  const rows = data.slice(0, ACTIVITY_PAGE_SIZE);
  const entries: ActivityEntryView[] = [];
  for (const row of rows) {
    // An unknown code (a newer database than this app) is left out rather than shown raw.
    if (!isActivityKind(row.kind)) continue;
    entries.push({
      id: row.id,
      category: oneOf(ACTIVITY_CATEGORIES, row.category, "security"),
      kind: row.kind,
      outcome: oneOf(ACTIVITY_OUTCOMES, row.outcome, "completed"),
      homeName: row.home_name || null,
      isCurrentMember: row.is_current_member,
      actor: oneOf(ACTIVITY_ACTORS, row.actor, "automatic"),
      roles: rolesOf(row.details),
      device: row.device_kind ? storedDevice(row.device_kind, row.browser, row.platform) : null,
      isCurrentSession: row.is_current_session,
      sessionLive: row.session_live,
      alerted: row.alerted,
      response: row.response === "confirmed" || row.response === "reported" ? row.response : null,
      createdAt: row.created_at,
    });
  }
  const last = rows.at(-1);
  return {
    status: "ok",
    value: {
      entries,
      next:
        data.length > ACTIVITY_PAGE_SIZE && last
          ? { createdAt: last.created_at, id: last.id }
          : null,
    },
  };
}

export interface ActivityHome {
  readonly id: string;
  readonly name: string;
}

/** The Homes that appear in the person's history, for the Home filter. */
export async function listMyActivityHomes(): Promise<readonly ActivityHome[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_activity_homes");
  if (error) {
    logFailure("activity.homes_failed", error.code);
    return [];
  }
  return data
    .map((row) => ({ id: row.home_id, name: row.home_name || "" }))
    .filter((home) => home.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SecurityAlertPreferences {
  readonly newDevice: boolean;
  readonly everySignIn: boolean;
}

export async function getSecurityAlertPreferences(): Promise<Loaded<SecurityAlertPreferences>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_security_alert_preferences");
  const row = data?.[0];
  if (error || !row) {
    logFailure("activity.alert_preferences_failed", error?.code);
    return { status: "unavailable" };
  }
  return { status: "ok", value: { newDevice: row.new_device, everySignIn: row.every_sign_in } };
}

export const EMAIL_STATES = [
  "none",
  "queued",
  "sent",
  "failed",
  "skipped",
  "not_configured",
] as const;
export type EmailState = (typeof EMAIL_STATES)[number];

export interface SecurityNoticeView {
  readonly id: string;
  readonly kind: string;
  readonly emailStatus: EmailState;
  readonly createdAt: string;
}

/** The person's recent security notices and their email state. */
export async function listMySecurityNotices(): Promise<Loaded<readonly SecurityNoticeView[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_security_notices", { p_limit: 10 });
  if (error) {
    logFailure("activity.notices_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      kind: row.kind,
      emailStatus: oneOf(EMAIL_STATES, row.email_status, "none"),
      createdAt: row.created_at,
    })),
  };
}

export const REPORT_STATES = ["ready", "expired", "discarded"] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export interface SecurityReportView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly snapshotAt: string;
  readonly expiresAt: string;
  readonly status: ReportState;
  readonly downloadedAt: string | null;
}

export async function listMySecurityReports(): Promise<Loaded<readonly SecurityReportView[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_security_reports");
  if (error) {
    logFailure("activity.reports_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      from: row.range_from,
      to: row.range_to,
      timeZone: row.timezone,
      snapshotAt: row.snapshot_at,
      expiresAt: row.expires_at,
      status: oneOf(REPORT_STATES, row.status, "expired"),
      downloadedAt: row.downloaded_at || null,
    })),
  };
}

/** S38: the Homes the person alone owns, which block deactivation until another Owner takes over. */
export async function listMyDeactivationBlockers(): Promise<
  Loaded<readonly { readonly homeId: string; readonly homeName: string }[]>
> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_deactivation_blockers");
  if (error) {
    logFailure("account.blockers_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.map((row) => ({ homeId: row.home_id, homeName: row.home_name })),
  };
}

/** S40: a Home its Owner closed, with the date it will be deleted for good. */
export interface ClosedHome {
  readonly homeId: string;
  readonly homeName: string;
  readonly purgeAfter: string;
}

/** S40: the Homes the person closed as their Owner and can still restore. */
export async function listMyClosedHomes(): Promise<Loaded<readonly ClosedHome[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_closed_homes");
  if (error) {
    logFailure("home.closed_list_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.map((row) => ({
      homeId: row.home_id,
      homeName: row.home_name,
      purgeAfter: row.purge_after,
    })),
  };
}

/** S40: what closing a Home affects, for its Owner (counts only). */
export interface HomeClosureSummary {
  readonly members: number;
  readonly invitations: number;
  readonly sharedCalendars: number;
}

export async function getHomeClosureSummary(homeId: string): Promise<Loaded<HomeClosureSummary>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("home_closure_summary", { p_home_id: homeId });
  const row = data?.[0];
  if (error || !row) {
    logFailure("home.closure_summary_failed", error?.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: {
      members: row.member_count,
      invitations: row.pending_invitations,
      sharedCalendars: row.shared_calendars,
    },
  };
}

/**
 * S38: records this visit as account activity (at most hourly in the database) and says whether a
 * security review is due after a long absence. A failure never blocks the page.
 */
export async function touchMyActivity(): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("touch_my_activity");
  if (error) {
    logFailure("account.touch_failed", error.code);
    return false;
  }
  return data;
}
