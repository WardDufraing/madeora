import { childCapabilities, type ChildCapability } from "@madeora/domain/permissions";
import { z } from "zod";

import { homeEndpoint } from "@/homes/api";
import { MemberActionError, sendMemberRequest } from "@/members/manage-api";

import type {
  AssignGuardianInput,
  ChildAccessInput,
  ChildPresentationInput,
  CreateChildInput,
  LinkCodeActionInput,
  OfferActionInput,
  RedeemLinkInput,
} from "./schema";

/**
 * The HTTP contract of the child-profile endpoints (S41; versioned for later mobile clients) and
 * the browser's callers for them. Same CSRF, content-type and size checks as the rest of `/api/v1`.
 *
 * - `POST /api/v1/homes/{homeId}/children` `CreateChildInput` → `201 { child: { membershipId } }`
 * - `PUT .../children/{membershipId}/access` `ChildAccessInput`
 *   → `200 { outcome: "saved" | "unchanged", before, after }`; a widening change without
 *   `confirmExpansion` → `409 confirmation-required`
 * - `PUT .../children/{membershipId}/presentation` `ChildPresentationInput` → `200 {}`
 * - `PUT .../children/{membershipId}/guardians` `AssignGuardianInput` → `200 { outcome: "offered" }`;
 *   the role applies only when the named adult accepts
 * - `POST .../children/offers/{offerId}` `{ action: "accept" | "decline" | "cancel" }`
 *   → `200 { outcome }`; an offer that lapsed → `409 expired` / `409 no-longer-valid`
 * - `POST .../children/{membershipId}/link-code` `{ action: "issue" | "cancel" }`
 *   → `200 { code, expiresAt }` (issue; the code is shown once) or `200 {}` (cancel)
 * - `POST .../children/link` `{ code, accentColor }` → `201 { child: { membershipId } }`
 * - `POST .../children/{membershipId}/delete` `{}` → `200 {}` (a mistaken creation, within the
 *   correction window, only Home) or `409 too-late` / `409 child-other-homes`
 * - `POST .../children/{membershipId}/guardians/remove-secondary` `{}` → `200 {}`
 * - `POST .../children/{membershipId}/remove` `{}` → `200 {}`; their only Home
 *   → `409 child-last-home`
 *
 * A Home the caller is not in, or a membership that is not a child of it: `404 not-found`. An
 * action their guardian role does not allow: `403 not-permitted`. An outdated edit: `409 stale`.
 */
export function childrenEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/children`;
}

export function childEndpoint(homeId: string, membershipId: string): string {
  return `${childrenEndpoint(homeId)}/${encodeURIComponent(membershipId)}`;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new MemberActionError("failed");
  return parsed.data;
}

const createResponseSchema = z.object({ child: z.object({ membershipId: z.string() }) });
const capabilityList = z.array(z.enum(childCapabilities));
const accessResponseSchema = z.object({
  outcome: z.enum(["saved", "unchanged"]),
  before: capabilityList,
  after: capabilityList,
});

export interface AccessResponse {
  readonly outcome: "saved" | "unchanged";
  readonly before: readonly ChildCapability[];
  readonly after: readonly ChildCapability[];
}

export async function createChild(
  homeId: string,
  input: CreateChildInput,
): Promise<{ readonly membershipId: string }> {
  return parse(
    createResponseSchema,
    await sendMemberRequest("POST", childrenEndpoint(homeId), input),
  ).child;
}

export async function setChildAccess(
  homeId: string,
  membershipId: string,
  input: ChildAccessInput,
): Promise<AccessResponse> {
  return parse(
    accessResponseSchema,
    await sendMemberRequest("PUT", `${childEndpoint(homeId, membershipId)}/access`, input),
  );
}

export async function setChildPresentation(
  homeId: string,
  membershipId: string,
  input: ChildPresentationInput,
): Promise<void> {
  await sendMemberRequest("PUT", `${childEndpoint(homeId, membershipId)}/presentation`, input);
}

export async function assignChildGuardian(
  homeId: string,
  membershipId: string,
  input: AssignGuardianInput,
): Promise<void> {
  await sendMemberRequest("PUT", `${childEndpoint(homeId, membershipId)}/guardians`, input);
}

const offerResponseSchema = z.object({
  outcome: z.enum(["accepted", "declined", "cancelled"]),
});

export async function answerGuardianOffer(
  homeId: string,
  offerId: string,
  input: OfferActionInput,
): Promise<"accepted" | "declined" | "cancelled"> {
  return parse(
    offerResponseSchema,
    await sendMemberRequest(
      "POST",
      `${childrenEndpoint(homeId)}/offers/${encodeURIComponent(offerId)}`,
      input,
    ),
  ).outcome;
}

export async function deleteMistakenChild(homeId: string, membershipId: string): Promise<void> {
  await sendMemberRequest("POST", `${childEndpoint(homeId, membershipId)}/delete`, {});
}

export async function removeChildSecondaryGuardian(
  homeId: string,
  membershipId: string,
): Promise<void> {
  await sendMemberRequest(
    "POST",
    `${childEndpoint(homeId, membershipId)}/guardians/remove-secondary`,
    {},
  );
}

export async function removeChild(homeId: string, membershipId: string): Promise<void> {
  await sendMemberRequest("POST", `${childEndpoint(homeId, membershipId)}/remove`, {});
}

const issueResponseSchema = z.object({ code: z.string(), expiresAt: z.string() });

/** Issues (or withdraws) the one-time code that links this child to another Home. */
export async function issueChildLinkCode(
  homeId: string,
  membershipId: string,
): Promise<{ readonly code: string; readonly expiresAt: string }> {
  const input: LinkCodeActionInput = { action: "issue" };
  return parse(
    issueResponseSchema,
    await sendMemberRequest("POST", `${childEndpoint(homeId, membershipId)}/link-code`, input),
  );
}

export async function cancelChildLinkCode(homeId: string, membershipId: string): Promise<void> {
  const input: LinkCodeActionInput = { action: "cancel" };
  await sendMemberRequest("POST", `${childEndpoint(homeId, membershipId)}/link-code`, input);
}

/** Redeems a link code in this Home; the caller becomes the child's primary guardian here. */
export async function redeemChildLinkCode(
  homeId: string,
  input: RedeemLinkInput,
): Promise<{ readonly membershipId: string }> {
  return parse(
    createResponseSchema,
    await sendMemberRequest("POST", `${childrenEndpoint(homeId)}/link`, input),
  ).child;
}
