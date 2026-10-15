import "server-only";

import { decideHomeAction, type HomeAction } from "@madeora/domain/permissions";
import { cache } from "react";
import { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";
import { getHomeContext, type HomeContext } from "@/homes/server";

import type { RecoveryErrorCode, RecoveryErrorResponse } from "./api";
import { recoveryStates, type FormerOwnerOutcome, type RecoveryState } from "./schema";

// Reads ---------------------------------------------------------------------------------------------

function isRecoveryState(value: string): value is RecoveryState {
  return (recoveryStates as readonly string[]).includes(value);
}

/** One recovery case as a member of the Home may see it (`public.home_ownership_recovery_status`). */
export interface RecoveryStatusView {
  readonly id: string;
  /** `claimant`: the caller asked; `owner`: the caller is the Owner it is about; `member`: anyone else. */
  readonly viewer: "claimant" | "owner" | "member";
  readonly state: RecoveryState;
  readonly createdAt: string;
  /** For the person who asked and the Owner, once approved. */
  readonly objectionEndsAt: string | null;
  /** For the Owner only: who asked (their membership in this Home). */
  readonly claimantMembershipId: string | null;
  /** The caller has objected to this case. */
  readonly objected: boolean;
}

export type RecoveryStatusResult =
  | { readonly status: "ok"; readonly cases: readonly RecoveryStatusView[] }
  | { readonly status: "unavailable" };

const viewers = ["claimant", "owner", "member"] as const;

/**
 * What the caller may see of recovery in `homeId`. Reading it as the Owner shows that the Owner has
 * access, which stops every open request about the Home: call it only where the Owner is actually
 * looking (the Home dashboard and the recovery page). Cached for this request only.
 */
export const getRecoveryStatus = cache(async (homeId: string): Promise<RecoveryStatusResult> => {
  const parsedId = homeIdSchema.safeParse(homeId);
  if (!parsedId.success) return { status: "ok", cases: [] };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("home_ownership_recovery_status", {
    p_home_id: parsedId.data,
  });
  if (error?.code === "42501") return { status: "ok", cases: [] };
  if (error) {
    console.error(JSON.stringify({ event: "recovery.status_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const cases: RecoveryStatusView[] = [];
  for (const row of data) {
    const viewer = viewers.find((value) => value === row.viewer);
    if (!viewer || !isRecoveryState(row.state)) continue;
    cases.push({
      id: row.id,
      viewer,
      state: row.state,
      createdAt: row.created_at,
      objectionEndsAt: row.objection_ends_at,
      claimantMembershipId: row.claimant_membership_id,
      objected: row.objected,
    });
  }
  return { status: "ok", cases };
});

/** A Home taken over from the caller through a completed recovery (`public.my_recovered_homes`). */
export interface RecoveredHomeView {
  readonly recoveryId: string;
  readonly homeName: string;
  readonly completedAt: string;
  readonly stillMember: boolean;
  readonly appealStatus: "open" | "closed" | null;
}

export const getRecoveredHomes = cache(
  async (): Promise<
    | { readonly status: "ok"; readonly homes: readonly RecoveredHomeView[] }
    | { readonly status: "unavailable" }
  > => {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("my_recovered_homes");
    if (error) {
      console.error(JSON.stringify({ event: "recovery.recovered_failed", code: error.code }));
      return { status: "unavailable" };
    }
    return {
      status: "ok",
      homes: data.map((row) => ({
        recoveryId: row.recovery_id,
        homeName: row.home_name,
        completedAt: row.completed_at,
        stillMember: row.still_member,
        appealStatus:
          row.appeal_status === "open" || row.appeal_status === "closed" ? row.appeal_status : null,
      })),
    };
  },
);

/** Whether the caller is Madeora staff. Only decides what to show; every staff call checks again. */
export const getIsStaff = cache(async (): Promise<boolean> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("is_madeora_staff");
  if (error) {
    console.error(JSON.stringify({ event: "recovery.staff_check_failed", code: error.code }));
    return false;
  }
  return data;
});

export interface StaffQueueItem {
  readonly id: string;
  readonly homeName: string;
  readonly state: RecoveryState;
  readonly createdAt: string;
  readonly objectionEndsAt: string | null;
  readonly objections: number;
  readonly openAppeals: number;
}

export type StaffRead<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "not-staff" }
  | { readonly status: "unavailable" };

export async function getStaffQueue(): Promise<StaffRead<readonly StaffQueueItem[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("staff_ownership_recoveries");
  if (error?.code === "42501") return { status: "not-staff" };
  if (error) {
    console.error(JSON.stringify({ event: "recovery.staff_queue_failed", code: error.code }));
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.flatMap((row) =>
      isRecoveryState(row.state)
        ? [
            {
              id: row.id,
              homeName: row.home_name,
              state: row.state,
              createdAt: row.created_at,
              objectionEndsAt: row.objection_ends_at,
              objections: row.objections,
              openAppeals: row.open_appeals,
            },
          ]
        : [],
    ),
  };
}

const objectionsSchema = z.array(
  z.object({
    role: z.enum(["owner", "administrator", "member"]),
    reason: z.string(),
    createdAt: z.string(),
  }),
);
const appealsSchema = z.array(
  z.object({
    id: z.string(),
    reason: z.string(),
    status: z.enum(["open", "closed"]),
    createdAt: z.string(),
    staffNotes: z.string().nullable(),
  }),
);

export interface StaffCase {
  readonly id: string;
  readonly homeId: string;
  readonly homeName: string;
  readonly homeTimeZone: string;
  readonly state: RecoveryState;
  readonly createdAt: string;
  readonly statement: string;
  readonly staffNotes: string | null;
  readonly formerOwnerOutcome: FormerOwnerOutcome | null;
  readonly reviewStartedAt: string | null;
  readonly approvedAt: string | null;
  readonly objectionEndsAt: string | null;
  readonly decidedAt: string | null;
  readonly ownerEmail: string | null;
  readonly ownerLocale: "en" | "nl" | null;
  readonly ownerLastSignInAt: string | null;
  readonly ownerSeenAt: string | null;
  readonly ownerIsOwner: boolean;
  readonly claimantEmail: string | null;
  readonly claimantName: string | null;
  readonly claimantRole: "owner" | "administrator" | "member" | null;
  readonly claimantMemberSince: string | null;
  readonly memberCount: number;
  readonly objections: z.infer<typeof objectionsSchema>;
  readonly appeals: z.infer<typeof appealsSchema>;
}

/** One case for staff; reading it is audited by the database. `null` value: no such case. */
export async function getStaffCase(recoveryId: string): Promise<StaffRead<StaffCase | null>> {
  const parsedId = z.uuid().safeParse(recoveryId);
  if (!parsedId.success) return { status: "ok", value: null };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("staff_ownership_recovery", {
    p_recovery_id: parsedId.data,
  });
  if (error?.code === "42501") return { status: "not-staff" };
  if (error) {
    console.error(JSON.stringify({ event: "recovery.staff_case_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const row = data[0];
  if (!row) return { status: "ok", value: null };
  const objections = objectionsSchema.safeParse(row.objections);
  const appeals = appealsSchema.safeParse(row.appeals);
  if (!isRecoveryState(row.state) || !objections.success || !appeals.success) {
    console.error(JSON.stringify({ event: "recovery.staff_case_unreadable" }));
    return { status: "unavailable" };
  }
  const role = row.claimant_role;
  return {
    status: "ok",
    value: {
      id: row.id,
      homeId: row.home_id,
      homeName: row.home_name,
      homeTimeZone: row.home_time_zone,
      state: row.state,
      createdAt: row.created_at,
      statement: row.statement,
      staffNotes: row.staff_notes,
      formerOwnerOutcome:
        row.former_owner_outcome === "member" || row.former_owner_outcome === "removed"
          ? row.former_owner_outcome
          : null,
      reviewStartedAt: row.review_started_at,
      approvedAt: row.approved_at,
      objectionEndsAt: row.objection_ends_at,
      decidedAt: row.decided_at,
      ownerEmail: row.owner_email,
      ownerLocale: row.owner_locale === "en" || row.owner_locale === "nl" ? row.owner_locale : null,
      ownerLastSignInAt: row.owner_last_sign_in_at,
      ownerSeenAt: row.owner_seen_at,
      ownerIsOwner: row.owner_is_owner,
      claimantEmail: row.claimant_email,
      claimantName: row.claimant_name,
      claimantRole: role === "owner" || role === "administrator" || role === "member" ? role : null,
      claimantMemberSince: row.claimant_member_since,
      memberCount: row.member_count,
      objections: objections.data,
      appeals: appeals.data,
    },
  };
}

// Route helpers ------------------------------------------------------------------------------------

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: RecoveryErrorCode,
  fields?: readonly string[],
): Response {
  const body: RecoveryErrorResponse = fields ? { error, fields } : { error };
  return json(status, body);
}

/**
 * The request checks every recovery endpoint makes, in order: same-origin JSON within the size
 * limit (CSRF), a confirmed identity, then the body against `schema`.
 */
export async function readRecoveryMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, maxBytes);
  if (refused) return { ok: false, response: failure(refused.status, refused.error) };
  if (!(await getVerifiedIdentity())) {
    return { ok: false, response: failure(401, "unauthenticated") };
  }
  const body = await readJsonBody(request, maxBytes);
  if (!body.ok) return { ok: false, response: failure(body.status, body.error) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) {
    return { ok: false, response: failure(400, "invalid", refusedFields(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * The caller's current membership of `homeId`, read from the database, and the engine's answer for
 * `action`. A Home they do not belong to is 404 whether or not it exists; one they belong to
 * without the right is 403. The database functions decide again under the Home's lock.
 */
export async function requireRecoveryAction(
  homeId: string,
  action: HomeAction,
): Promise<
  | { readonly ok: true; readonly context: HomeContext }
  | { readonly ok: false; readonly response: Response }
> {
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return { ok: false, response: failure(500, "failed") };
  if (found.status === "not-found") return { ok: false, response: failure(404, "not-found") };
  const { home, membership } = found.context;
  if (!decideHomeAction(home.id, membership, action).allowed) {
    return { ok: false, response: failure(403, "not-permitted") };
  }
  return { ok: true, context: found.context };
}

/** Answers for the outcomes the recovery functions share. */
export function outcomeFailure(outcome: string): Response {
  switch (outcome) {
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "already_open":
      return failure(409, "already-open");
    case "already_decided":
      return failure(409, "already-decided");
    case "not_ready":
      return failure(409, "not-ready");
    case "owner_returned":
      return failure(409, "owner-returned");
    case "no_longer_valid":
      return failure(409, "no-longer-valid");
    case "nothing_open":
      return failure(409, "nothing-open");
    case "not_allowed":
      return failure(409, "not-allowed");
    default:
      return failure(500, "failed");
  }
}

/**
 * Maps a database error: malformed input 400; for staff endpoints, a missing staff status 404 (the
 * endpoints do not reveal themselves) and an old sign-in 401 `reauthenticate`; an unconfirmed
 * session 401; anything else 500.
 */
export function databaseFailure(
  event: string,
  error: { readonly code?: string; readonly hint?: string | null },
  options: { readonly staff?: boolean } = {},
): Response {
  if (error.code === "22023" || error.code === "22P02") return failure(400, "invalid");
  if (error.code === "42501") {
    if (options.staff && error.hint === "reauthenticate") return failure(401, "reauthenticate");
    if (options.staff) return failure(404, "not-found");
    return failure(401, "unauthenticated");
  }
  // Privacy-safe: the error code only, no account or Home ids, no names.
  console.error(JSON.stringify({ event, code: error.code ?? null }));
  return failure(500, "failed");
}
