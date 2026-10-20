import type {
  NotificationChannel,
  OptionalNotificationCategory,
} from "@madeora/domain/notifications";

/** One notification as the notification centre shows it. Client-safe. */
export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  /** The source Home; null for notices about the account or a Home the person is not in. */
  readonly homeId: string | null;
  readonly homeName: string | null;
  /** Dates and codes only (never free text); the words come from the reader's language. */
  readonly objectionEndsAt: string | null;
  readonly decision: "approved" | "declined" | null;
  /** A reminder's task (S19b), its due day, and its title when the reader can still see it. */
  readonly taskId: string | null;
  readonly dueDate: string | null;
  readonly taskTitle: string | null;
  readonly duringQuietHours: boolean;
  readonly createdAt: string;
  readonly readAt: string | null;
}

/** One effective choice for a scope: the account's defaults (`homeId` null) or one Home. */
export interface PreferenceRow {
  readonly homeId: string | null;
  readonly category: OptionalNotificationCategory;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  /** Set explicitly for this scope; false means inherited (a Home) or Madeora's default. */
  readonly overridden: boolean;
}

/** Stored quiet hours of a scope (`homeId` null: the account's). */
export interface QuietHoursRow {
  readonly homeId: string | null;
  readonly enabled: boolean;
  /** `HH:MM`, wall-clock in `timeZone`. */
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}
