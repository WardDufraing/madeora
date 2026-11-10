/**
 * The account activity history (S38, spec "Confirmed categorized private account activity
 * history"): its five categories and every event code the database records
 * (supabase/migrations/20261124090000_activity_history.sql). The app turns codes into words in
 * the reader's language; nothing here is user-typed.
 */
export const ACTIVITY_CATEGORIES = [
  "security",
  "privacy",
  "profile",
  "integrations",
  "home_memberships",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_OUTCOMES = [
  "completed",
  "pending",
  "declined",
  "blocked",
  "failed",
  "cancelled",
  "expired",
] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Who acted, as a safe role: never another person's identity. */
export const ACTIVITY_ACTORS = [
  "self",
  "home_member",
  "home_manager",
  "madeora",
  "automatic",
] as const;
export type ActivityActor = (typeof ACTIVITY_ACTORS)[number];

export const ACTIVITY_KINDS = {
  security: [
    "signed_in",
    "sign_in_unfinished",
    "password_changed",
    "email_change_requested",
    "email_change_cancelled",
    "email_changed",
    "two_factor_enrolled",
    "two_factor_disabled",
    "recovery_codes_created",
    "recovery_code_used",
    "recovery_code_failed",
    "session_revoked",
    "session_reported",
    "signed_out_everywhere",
    "device_trusted",
    "device_trust_revoked",
    "backup_email_requested",
    "backup_email_changed",
    "backup_email_removed",
    "account_recovery_codes_created",
    "account_recovery_requested",
    "account_recovery_code_failed",
    "account_recovery_started",
    "account_recovery_cancelled",
    "account_recovered",
    "security_report_requested",
    "security_report_downloaded",
    "security_report_discarded",
    "security_alerts_changed",
    "google_sign_in_linked",
    "google_sign_in_unlinked",
    "account_deactivated",
    "account_reactivated",
    "inactivity_reminder_sent",
    "security_review_completed",
    "ownership_recovery",
  ],
  // S39: personal data exports and the guided privacy review.
  privacy: [
    "data_export_requested",
    "data_export_ready",
    "data_export_failed",
    "data_export_canceled",
    "data_export_downloaded",
    "privacy_review_started",
    "privacy_review_completed",
    // S40: account deletion and its cancellation.
    "account_deletion_requested",
    "account_deletion_canceled",
  ],
  profile: [
    "profile.name_changed",
    "profile.accent_changed",
    "profile.avatar_changed",
    "profile.home_name_changed",
    "profile.home_accent_changed",
    "profile.home_avatar_changed",
  ],
  integrations: [
    "google_calendar.connected",
    "google_calendar.reconnected",
    "google_calendar.disconnected",
    "google_calendar.authorization_expired",
    "google_calendar.paused",
    "google_calendar.shared",
    "google_calendar.unshared",
    "google_calendar.connect_failed",
  ],
  home_memberships: [
    "home_membership.joined",
    "home_membership.left",
    "home_membership.removed",
    "home_membership.role_changed",
    "home_membership.permissions_changed",
    "join_request",
    "invitation",
    "home_ownership.transfer",
    // S40: the Owner closed or restored a Home.
    "home.closed",
    "home.restored",
  ],
} as const satisfies Record<ActivityCategory, readonly string[]>;

export type ActivityKind = (typeof ACTIVITY_KINDS)[ActivityCategory][number];

export const ALL_ACTIVITY_KINDS: readonly ActivityKind[] = ACTIVITY_CATEGORIES.flatMap(
  (category) => ACTIVITY_KINDS[category],
);

export function isActivityKind(value: string): value is ActivityKind {
  return (ALL_ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** The message key of an event code (`home_membership.joined` → `kind_home_membership_joined`). */
type Undot<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${Undot<B>}` : S;
export type ActivityKindKey<K extends ActivityKind = ActivityKind> = `kind_${Undot<K>}`;
export function kindKey<K extends ActivityKind>(kind: K): ActivityKindKey<K> {
  return `kind_${kind.replaceAll(".", "_")}` as ActivityKindKey<K>;
}

export const ROLE_CODES = ["owner", "administrator", "member"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export function isRoleCode(value: unknown): value is RoleCode {
  return (ROLE_CODES as readonly unknown[]).includes(value);
}
