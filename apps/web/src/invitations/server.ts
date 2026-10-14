import "server-only";

import { getLocale } from "next-intl/server";
import { cache } from "react";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";
import { defaultLocale, isLocale } from "@/i18n/locales";
import { getEffectiveTimeZone, getRegionalFormats } from "@/preferences/server";

import type { DateTimeFormats } from "./format";
import { emailLanguages, invitationKinds, invitationRoles, joinTokenSchema } from "./schema";
import {
  deliveryStatuses,
  invitationStates,
  isOneOf,
  previewOutcomes,
  requestStates,
  type InvitationPreview,
  type InvitationView,
  type JoinRequestView,
  type MyJoinRequestView,
} from "./types";

/**
 * Reads for the invitation pages (S10). Every read calls a database function with the person's
 * own session; the function checks their current membership and authority, and returns only what
 * they may see. Rows are checked here again before they reach a page, so a schema drift fails
 * closed (the row is dropped) instead of showing something half-understood.
 */

export type ListResult<T> =
  | { readonly status: "ok"; readonly items: readonly T[] }
  /** Not a manager of this Home (or not a member at all). */
  | { readonly status: "not-permitted" }
  | { readonly status: "unavailable" };

function logFailure(event: string, code: string | undefined): void {
  // Privacy-safe: the error code only, no ids, names or addresses.
  console.error(JSON.stringify({ event, code }));
}

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function toInvitation(row: Record<string, unknown>): InvitationView | null {
  const { id, kind, role, state, created_at, expires_at } = row;
  if (
    typeof id !== "string" ||
    !isOneOf(invitationKinds, kind) ||
    !isOneOf(invitationRoles, role) ||
    !isOneOf(invitationStates, state) ||
    typeof created_at !== "string" ||
    typeof expires_at !== "string"
  ) {
    return null;
  }
  return {
    id,
    kind,
    role,
    recipientEmail: nullableString(row.recipient_email),
    emailLanguage: isOneOf(emailLanguages, row.email_locale) ? row.email_locale : null,
    state,
    createdAt: created_at,
    expiresAt: expires_at,
    endedAt: nullableString(row.ended_at),
    maxUses: typeof row.max_admissions === "number" ? row.max_admissions : null,
    uses: typeof row.admissions === "number" ? row.admissions : 0,
    pendingRequests: typeof row.pending_requests === "number" ? row.pending_requests : 0,
    delivery: isOneOf(deliveryStatuses, row.delivery_status) ? row.delivery_status : null,
    lastSentAt: nullableString(row.last_sent_at),
    token: nullableString(row.token),
  };
}

/** A Home's invitations, for its managers. Cached for this request only. */
export const listHomeInvitations = cache(
  async (homeId: string): Promise<ListResult<InvitationView>> => {
    if (!homeIdSchema.safeParse(homeId).success) return { status: "not-permitted" };
    if (!(await getVerifiedIdentity())) return { status: "not-permitted" };
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("list_home_invitations", { p_home_id: homeId });
    if (error?.code === "42501") return { status: "not-permitted" };
    if (error) {
      logFailure("invitations.list_failed", error.code);
      return { status: "unavailable" };
    }
    const items = data
      .map((row) => toInvitation(row))
      .filter((item): item is InvitationView => item !== null);
    return { status: "ok", items };
  },
);

function toJoinRequest(row: Record<string, unknown>): JoinRequestView | null {
  const { id, applicant_email, role, kind, state, created_at } = row;
  if (
    typeof id !== "string" ||
    typeof applicant_email !== "string" ||
    !isOneOf(invitationRoles, role) ||
    !isOneOf(invitationKinds, kind) ||
    !isOneOf(requestStates, state) ||
    typeof created_at !== "string"
  ) {
    return null;
  }
  return {
    id,
    applicantName: nullableString(row.applicant_name),
    applicantEmail: applicant_email,
    role,
    kind,
    state,
    createdAt: created_at,
    decidedAt: nullableString(row.decided_at),
    canDecide: row.can_decide === true,
  };
}

/** A Home's join requests, for its managers. Cached for this request only. */
export const listHomeJoinRequests = cache(
  async (homeId: string): Promise<ListResult<JoinRequestView>> => {
    if (!homeIdSchema.safeParse(homeId).success) return { status: "not-permitted" };
    if (!(await getVerifiedIdentity())) return { status: "not-permitted" };
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("list_home_join_requests", { p_home_id: homeId });
    if (error?.code === "42501") return { status: "not-permitted" };
    if (error) {
      logFailure("join_requests.list_failed", error.code);
      return { status: "unavailable" };
    }
    const items = data
      .map((row) => toJoinRequest(row))
      .filter((item): item is JoinRequestView => item !== null);
    return { status: "ok", items };
  },
);

/** How many join requests the signed-in manager can act on; 0 for everyone else or on failure. */
export const countPendingJoinRequests = cache(async (homeId: string): Promise<number> => {
  if (!homeIdSchema.safeParse(homeId).success) return 0;
  if (!(await getVerifiedIdentity())) return 0;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("count_pending_join_requests", { p_home_id: homeId });
  if (error) {
    logFailure("join_requests.count_failed", error.code);
    return 0;
  }
  return data;
});

function toMyJoinRequest(row: Record<string, unknown>): MyJoinRequestView | null {
  const { id, home_name, role, kind, state, created_at } = row;
  if (
    typeof id !== "string" ||
    typeof home_name !== "string" ||
    !isOneOf(invitationRoles, role) ||
    (kind !== "invitation" && kind !== "join_code") ||
    !isOneOf(requestStates, state) ||
    typeof created_at !== "string"
  ) {
    return null;
  }
  return {
    id,
    homeId: nullableString(row.home_id),
    homeName: home_name,
    role,
    kind,
    state,
    createdAt: created_at,
    decidedAt: nullableString(row.decided_at),
  };
}

/** The signed-in person's own join requests. */
export const listMyJoinRequests = cache(async (): Promise<ListResult<MyJoinRequestView>> => {
  if (!(await getVerifiedIdentity())) return { status: "not-permitted" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_join_requests");
  if (error) {
    logFailure("join_requests.list_mine_failed", error.code);
    return { status: "unavailable" };
  }
  const items = data
    .map((row) => toMyJoinRequest(row))
    .filter((item): item is MyJoinRequestView => item !== null);
  return { status: "ok", items };
});

export type PreviewResult =
  | { readonly status: "ok"; readonly preview: InvitationPreview }
  | { readonly status: "unavailable" };

/**
 * What the link or code `token` shows the signed-in person. A failed lookup counts toward their
 * guessing limit, so this is called once per page view (cached for the request).
 */
export const previewInvitation = cache(async (token: string): Promise<PreviewResult> => {
  const parsed = joinTokenSchema.safeParse(token);
  if (!parsed.success) return { status: "ok", preview: { outcome: "invalid" } };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_home_invitation", { p_token: parsed.data });
  if (error) {
    logFailure("invitations.preview_failed", error.code);
    return { status: "unavailable" };
  }
  const row = data[0] as Record<string, unknown> | undefined;
  return { status: "ok", preview: toPreview(row) };
});

export function toPreview(row: Record<string, unknown> | undefined): InvitationPreview {
  const outcome = row?.outcome;
  if (!row || !isOneOf(previewOutcomes, outcome)) return { outcome: "invalid" };
  if (outcome === "ok") {
    const { home_name, role, kind, expires_at } = row;
    if (
      typeof home_name !== "string" ||
      !isOneOf(invitationRoles, role) ||
      !isOneOf(invitationKinds, kind) ||
      typeof expires_at !== "string"
    ) {
      return { outcome: "invalid" };
    }
    return { outcome, homeName: home_name, role, kind, expiresAt: expires_at };
  }
  if (outcome === "already_member") {
    if (typeof row.home_id !== "string" || typeof row.home_name !== "string") {
      return { outcome: "invalid" };
    }
    return { outcome, homeId: row.home_id, homeName: row.home_name };
  }
  if (outcome === "pending") {
    return typeof row.home_name === "string"
      ? { outcome, homeName: row.home_name }
      : { outcome: "invalid" };
  }
  return { outcome };
}

/** The viewer's timezone and regional formats, for the dates the invitation pages show. */
export async function getDateTimeFormats(): Promise<DateTimeFormats> {
  const [zone, regional, locale] = await Promise.all([
    getEffectiveTimeZone(),
    getRegionalFormats(),
    getLocale(),
  ]);
  return {
    timeZone: zone.timeZone,
    dateFormat: regional.effective.dateFormat,
    timeFormat: regional.effective.timeFormat,
    locale: isLocale(locale) ? locale : defaultLocale,
  };
}
