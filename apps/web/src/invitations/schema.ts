import { z } from "zod";

/**
 * Invitation input rules (S10), shared by the forms and the API routes. The database functions
 * check the same rules (supabase/migrations/20261017090000_home_invitations.sql); change both
 * together. Client-safe.
 */

export const invitationKinds = ["email", "link", "join_code"] as const;
export type InvitationKind = (typeof invitationKinds)[number];

/** Roles an invitation can propose. Never Owner (spec: ownership changes only by transfer). */
export const invitationRoles = ["member", "administrator"] as const;
export type InvitationRole = (typeof invitationRoles)[number];

/** Spec: 24 hours, 7 days (default) or 30 days for links; email invitations always 7 days. */
export const expiryChoices = ["24h", "7d", "30d"] as const;
export type ExpiryChoice = (typeof expiryChoices)[number];
export const DEFAULT_EXPIRY: ExpiryChoice = "7d";

/** Spec: a multi-use link allows 2 to 10 successful admissions. */
export const MIN_MULTI_USE = 2;
export const MAX_MULTI_USE = 10;
/** Spec: at most 25 active invitations per Home. */
export const ACTIVE_INVITATION_LIMIT = 25;

export const emailLanguages = ["en", "nl"] as const;
export type EmailLanguage = (typeof emailLanguages)[number];

/** Error message keys, translated in the `Invitations` namespace. */
export type InvitationFieldError = "emailRequired" | "emailInvalid" | "maxUsesInvalid";

const recipientEmailSchema = z
  .string({ error: "emailRequired" satisfies InvitationFieldError })
  .trim()
  .toLowerCase()
  .min(1, { error: "emailRequired" satisfies InvitationFieldError })
  .max(254, { error: "emailInvalid" satisfies InvitationFieldError })
  .pipe(z.email({ error: "emailInvalid" satisfies InvitationFieldError }));

const requestId = z.uuid();

/**
 * `POST /api/v1/homes/{homeId}/invitations`. `requestId` is generated once per form submission
 * series, so a double click or a retry never creates two invitations.
 */
export const createInvitationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("email"),
    role: z.enum(invitationRoles),
    email: recipientEmailSchema,
    language: z.enum(emailLanguages),
    requestId,
  }),
  z.strictObject({
    kind: z.literal("link"),
    role: z.enum(invitationRoles),
    expiresIn: z.enum(expiryChoices),
    maxUses: z.int().min(1).max(MAX_MULTI_USE),
    requestId,
  }),
  z.strictObject({
    kind: z.literal("join_code"),
    expiresIn: z.enum(expiryChoices),
    requestId,
  }),
]);
export type CreateInvitationInput = z.input<typeof createInvitationSchema>;
export type CreateInvitation = z.output<typeof createInvitationSchema>;

/**
 * The "Invite people" form: one flat set of fields whose meaning depends on the chosen kind.
 * `toCreateInvitation` turns it into the API's input.
 */
export const invitationFormSchema = z
  .object({
    kind: z.enum(invitationKinds),
    role: z.enum(invitationRoles),
    email: z.string().max(1000),
    language: z.enum(emailLanguages),
    expiresIn: z.enum(expiryChoices),
    usage: z.enum(["single", "multi"]),
    maxUses: z.string().max(10),
  })
  .superRefine((values, context) => {
    if (values.kind === "email") {
      const email = recipientEmailSchema.safeParse(values.email);
      if (!email.success) {
        context.addIssue({
          code: "custom",
          path: ["email"],
          message:
            email.error.issues[0]?.message ?? ("emailInvalid" satisfies InvitationFieldError),
        });
      }
    }
    if (values.kind === "link" && values.usage === "multi") {
      const uses = Number(values.maxUses);
      if (!/^\d+$/.test(values.maxUses) || uses < MIN_MULTI_USE || uses > MAX_MULTI_USE) {
        context.addIssue({
          code: "custom",
          path: ["maxUses"],
          message: "maxUsesInvalid" satisfies InvitationFieldError,
        });
      }
    }
  });
export type InvitationFormValues = z.input<typeof invitationFormSchema>;

export function toCreateInvitation(
  values: z.output<typeof invitationFormSchema>,
  requestId: string,
): CreateInvitationInput {
  switch (values.kind) {
    case "email":
      return {
        kind: "email",
        role: values.role,
        email: values.email.trim(),
        language: values.language,
        requestId,
      };
    case "link":
      return {
        kind: "link",
        role: values.role,
        expiresIn: values.expiresIn,
        maxUses: values.usage === "multi" ? Number(values.maxUses) : 1,
        requestId,
      };
    case "join_code":
      return { kind: "join_code", expiresIn: values.expiresIn, requestId };
  }
}

/** `POST /api/v1/homes/{homeId}/join-requests/{id}/decision`. */
export const decisionSchema = z.strictObject({ decision: z.enum(["approve", "decline"]) });
export type DecisionInput = z.input<typeof decisionSchema>;

/**
 * An invitation link's secret or a typed join code, as it arrives (`POST /api/v1/join-requests`
 * and the `/join/{token}` page). The database normalises codes (case, spaces, dashes, look-alike
 * letters) and checks the format; this only bounds the size.
 */
export const joinTokenSchema = z.string().trim().min(1).max(100);
export const joinRequestSchema = z.strictObject({ token: joinTokenSchema });
export type JoinRequestInput = z.input<typeof joinRequestSchema>;

/** Shows a 10-character join code as `ABCDE-FGHJK`, easier to read aloud and type. */
export function formatJoinCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** Whether `value` looks like a join code someone typed (before the database normalises it). */
export function looksLikeJoinCode(value: string): boolean {
  return /^[0-9A-Za-z]{5}[\s-]*[0-9A-Za-z]{5}$/.test(value.trim());
}
