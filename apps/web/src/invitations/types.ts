import type { EmailLanguage, InvitationKind, InvitationRole } from "./schema";

/**
 * What the invitation pages show. Client-safe: built on the server from the database functions'
 * answers, which already left out everything the viewer may not see.
 */

/** An invitation as its managers see it. `active` means it can still admit someone. */
export const invitationStates = [
  "active",
  "expired",
  "revoked",
  "declined",
  "accepted",
  "used_up",
  "invalid",
] as const;
export type InvitationState = (typeof invitationStates)[number];

export const deliveryStatuses = ["pending", "sent", "failed", "not_configured"] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export interface InvitationView {
  readonly id: string;
  readonly kind: InvitationKind;
  readonly role: InvitationRole;
  /** Email invitations only. */
  readonly recipientEmail: string | null;
  readonly emailLanguage: EmailLanguage | null;
  readonly state: InvitationState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  /** `null`: no cap (join codes). */
  readonly maxUses: number | null;
  readonly uses: number;
  readonly pendingRequests: number;
  readonly delivery: DeliveryStatus | null;
  readonly lastSentAt: string | null;
  /** Active links and codes only: the secret to copy. Never for email invitations. */
  readonly token: string | null;
}

export const requestStates = ["pending", "approved", "declined", "withdrawn", "expired"] as const;
export type RequestState = (typeof requestStates)[number];

/** A join request as the Home's managers see it. */
export interface JoinRequestView {
  readonly id: string;
  readonly applicantName: string | null;
  readonly applicantEmail: string;
  readonly role: InvitationRole;
  readonly kind: InvitationKind;
  readonly state: RequestState;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** Whether this manager may approve or decline it (Administrator requests: Owner only). */
  readonly canDecide: boolean;
}

/** One of the signed-in person's own join requests. */
export interface MyJoinRequestView {
  readonly id: string;
  /** Set only while they belong to the Home, so the page can link there. */
  readonly homeId: string | null;
  readonly homeName: string;
  readonly role: InvitationRole;
  readonly kind: "invitation" | "join_code";
  readonly state: RequestState;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/** What a link or code shows the signed-in person, and why not when it cannot be used. */
export const previewOutcomes = [
  "ok",
  "invalid",
  "expired",
  "revoked",
  "used_up",
  "email_mismatch",
  "already_member",
  "pending",
  "declined",
  "rate_limited",
] as const;
export type PreviewOutcome = (typeof previewOutcomes)[number];

export type InvitationPreview =
  | {
      readonly outcome: "ok";
      readonly homeName: string;
      readonly role: InvitationRole;
      readonly kind: InvitationKind;
      readonly expiresAt: string;
    }
  | { readonly outcome: "already_member"; readonly homeId: string; readonly homeName: string }
  | { readonly outcome: "pending"; readonly homeName: string }
  | { readonly outcome: Exclude<PreviewOutcome, "ok" | "already_member" | "pending"> };

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
