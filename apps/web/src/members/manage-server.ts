import "server-only";

import {
  decideHomeAction,
  decideMemberAction,
  isDelegableCapability,
  type DelegableCapability,
  type HomeAction,
  type MemberAction,
} from "@madeora/domain/permissions";
import { cache } from "react";
import type { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";
import { getHomeContext, type HomeContext } from "@/homes/server";

import { getHomeDirectory } from "./directory";
import type { DirectoryMember } from "./directory-view";
import type { MemberErrorCode, MemberErrorResponse } from "./manage-api";

// Reads ---------------------------------------------------------------------------------------------

export type CapabilityGrants =
  | {
      readonly status: "ok";
      /** Granted capabilities by membership id. The Owner sees every Administrator's; anyone
       * else only their own. */
      readonly byMembership: ReadonlyMap<string, ReadonlySet<DelegableCapability>>;
    }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/** The Administrator grants in `homeId` the caller may see (`public.home_capabilities`). */
export const getCapabilityGrants = cache(async (homeId: string): Promise<CapabilityGrants> => {
  const parsedId = homeIdSchema.safeParse(homeId);
  if (!parsedId.success) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("home_capabilities", { p_home_id: parsedId.data });
  if (error?.code === "42501") return { status: "not-found" };
  if (error) {
    console.error(JSON.stringify({ event: "members.capabilities_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const byMembership = new Map<string, Set<DelegableCapability>>();
  for (const row of data) {
    if (!isDelegableCapability(row.capability)) continue;
    const set = byMembership.get(row.membership_id) ?? new Set<DelegableCapability>();
    set.add(row.capability);
    byMembership.set(row.membership_id, set);
  }
  return { status: "ok", byMembership };
});

export const transferStates = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
  "invalid",
] as const;
export type TransferState = (typeof transferStates)[number];

/** The Home's ownership transfer as the caller may see it (client-safe shape). */
export interface OwnershipTransferView {
  readonly id: string;
  readonly state: TransferState;
  /** The caller started it (they are, or were, the Owner). */
  readonly isSender: boolean;
  /** The caller is the member it nominates. */
  readonly isRecipient: boolean;
  /** The nominated member's membership, or `null` when they are no longer in the Home. */
  readonly recipientMembershipId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

export type OwnershipTransferResult =
  | { readonly status: "ok"; readonly transfer: OwnershipTransferView | null }
  | { readonly status: "unavailable" };

/**
 * The pending transfer for its sender and recipient, or a recently ended one for its sender
 * (`public.home_ownership_transfer`); `null` for everyone else. Cached for this request only.
 */
export const getOwnershipTransfer = cache(
  async (homeId: string): Promise<OwnershipTransferResult> => {
    const parsedId = homeIdSchema.safeParse(homeId);
    if (!parsedId.success) return { status: "ok", transfer: null };
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("home_ownership_transfer", {
      p_home_id: parsedId.data,
    });
    if (error?.code === "42501") return { status: "ok", transfer: null };
    if (error) {
      console.error(JSON.stringify({ event: "members.transfer_read_failed", code: error.code }));
      return { status: "unavailable" };
    }
    const row = data[0];
    if (!row || !(transferStates as readonly string[]).includes(row.state)) {
      return { status: "ok", transfer: null };
    }
    return {
      status: "ok",
      transfer: {
        id: row.id,
        state: row.state as TransferState,
        isSender: row.is_sender,
        isRecipient: row.is_recipient,
        recipientMembershipId: row.recipient_membership_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        decidedAt: row.decided_at,
      },
    };
  },
);

// Route helpers ------------------------------------------------------------------------------------

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: MemberErrorCode,
  fields?: readonly string[],
): Response {
  const body: MemberErrorResponse = fields ? { error, fields } : { error };
  return json(status, body);
}

/**
 * The request checks every member-management endpoint makes, in order: same-origin JSON within the
 * size limit (CSRF), a confirmed identity, then the body against `schema`.
 */
export async function readMemberMutation<S extends z.ZodType>(
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

type Allowed<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly response: Response };

/**
 * The caller's current membership of `homeId`, read from the database, and the engine's answer for
 * `action`. A Home they do not belong to is 404 whether or not it exists; one they belong to
 * without the right is 403. The database functions decide again under a lock.
 */
export async function requireHomeAction(
  homeId: string,
  action: HomeAction,
): Promise<Allowed<{ readonly context: HomeContext }>> {
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return { ok: false, response: failure(500, "failed") };
  if (found.status === "not-found") return { ok: false, response: failure(404, "not-found") };
  const { home, membership } = found.context;
  if (!decideHomeAction(home.id, membership, action).allowed) {
    return { ok: false, response: failure(403, "not-permitted") };
  }
  return { ok: true, context: found.context };
}

/**
 * As `requireHomeAction`, for an action on another member: the target is read from the Home's
 * directory (never from the request), so the engine decides with their current role and whether
 * it is the caller. A member who is not in this Home answers 404.
 */
export async function requireMemberAction(
  homeId: string,
  membershipId: string,
  action: MemberAction,
): Promise<Allowed<{ readonly context: HomeContext; readonly target: DirectoryMember }>> {
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return { ok: false, response: failure(500, "failed") };
  if (found.status === "not-found") return { ok: false, response: failure(404, "not-found") };
  const directory = await getHomeDirectory(found.context.home.id);
  if (directory.status === "unavailable") return { ok: false, response: failure(500, "failed") };
  if (directory.status === "not-found") return { ok: false, response: failure(404, "not-found") };
  const target = directory.members.find((member) => member.membershipId === membershipId);
  if (!target) return { ok: false, response: failure(404, "not-found") };
  const { home, membership } = found.context;
  const decision = decideMemberAction(
    home.id,
    membership,
    { homeId: home.id, role: target.role, isSelf: target.isSelf },
    action,
  );
  if (!decision.allowed) return { ok: false, response: failure(403, "not-permitted") };
  return { ok: true, context: found.context, target };
}

/** Answers for the outcomes the database functions share. */
export function outcomeFailure(outcome: string): Response {
  switch (outcome) {
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "stale":
      return failure(409, "stale");
    case "pending_exists":
      return failure(409, "pending-exists");
    case "invalid_target":
      return failure(409, "invalid-target");
    case "owner_must_transfer":
      return failure(409, "owner-must-transfer");
    case "already_decided":
      return failure(409, "already-decided");
    case "expired":
      return failure(409, "expired");
    case "no_longer_valid":
      return failure(409, "no-longer-valid");
    default:
      return failure(500, "failed");
  }
}

/** Maps a database error: malformed input 400, an unconfirmed session 401, anything else 500. */
export function databaseFailure(event: string, code: string | undefined): Response {
  if (code === "22023" || code === "22P02") return failure(400, "invalid");
  if (code === "42501") return failure(401, "unauthenticated");
  // Privacy-safe: the error code only, no account or Home ids, no names.
  console.error(JSON.stringify({ event, code: code ?? null }));
  return failure(500, "failed");
}
