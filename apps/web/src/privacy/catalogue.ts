/**
 * Personal and Home data export categories and guided privacy review steps (S39). The database is the
 * authority (`private.personal_export_categories()`, `private.privacy_reviews`); these lists only
 * drive the interface, in the same order.
 */
export const EXPORT_CATEGORIES = [
  "account",
  "calendar",
  "tasks",
  "recipes",
  "shopping",
  "meals",
  "habits_goals",
  "media",
  "home_contributions",
] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

export function isExportCategory(value: string): value is ExportCategory {
  return (EXPORT_CATEGORIES as readonly string[]).includes(value);
}

/** Home export categories (`private.home_export_categories()`), in the same order. */
export const HOME_EXPORT_CATEGORIES = [
  "home",
  "tasks",
  "chores",
  "calendar",
  "recipes",
  "shopping",
  "meals",
  "habits_goals",
  "pets",
  "photos",
  "points",
] as const;
export type HomeExportCategory = (typeof HOME_EXPORT_CATEGORIES)[number];

export function isHomeExportCategory(value: string): value is HomeExportCategory {
  return (HOME_EXPORT_CATEGORIES as readonly string[]).includes(value);
}

export type ExportKind = "personal" | "home";
export type AnyExportCategory = ExportCategory | HomeExportCategory;

/** Categories whose content depends on the Homes chosen (Home-specific settings, contributions). */
export const HOME_SCOPED_CATEGORIES: readonly ExportCategory[] = ["account", "home_contributions"];

export const EXPORT_STATUSES = [
  "queued",
  "preparing",
  "ready",
  "failed",
  "canceled",
  "expired",
  "invalidated",
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const REVIEW_STEPS = [
  "profile",
  "homes",
  "connections",
  "security",
  "devices",
  "data_rights",
] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

export function isReviewStep(value: unknown): value is ReviewStep {
  return (REVIEW_STEPS as readonly unknown[]).includes(value);
}

/** Who a setting applies to, as the dashboard labels it (spec: never an account-wide toggle for a Home rule). */
export type SettingScope = "account" | "home" | "device";

/** One value per review step, typed as a complete record. */
export function perReviewStep<T>(make: (step: ReviewStep) => T): Record<ReviewStep, T> {
  return {
    profile: make("profile"),
    homes: make("homes"),
    connections: make("connections"),
    security: make("security"),
    devices: make("devices"),
    data_rights: make("data_rights"),
  };
}

/**
 * Personal categories that can be deleted on Settings › Privacy › Delete data by category (S40
 * part 2), in the database's order (`private.personal_deletion_categories()`): the export's keys
 * without the account itself and the person's contributions to Homes (Home-owned records).
 */
export const DELETION_CATEGORIES = [
  "calendar",
  "tasks",
  "recipes",
  "shopping",
  "meals",
  "habits_goals",
  "media",
] as const;
export type DeletionCategory = (typeof DELETION_CATEGORIES)[number];

/** Categories shown as not deletable here, each with its reason. */
export const UNDELETABLE_CATEGORIES = ["account", "home_contributions", "security"] as const;

/** Categories whose items can have been copied into a Home or have pending copy requests. */
export const COPYABLE_DELETION_CATEGORIES: readonly DeletionCategory[] = [
  "calendar",
  "recipes",
  "media",
];
