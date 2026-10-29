import type {
  NotificationChannel,
  OptionalNotificationCategory,
} from "@madeora/domain/notifications";

/** A join request's decision (S11), a chore reassignment request's answer or decision, or a chore
 * proposal's decision (S21). */
export const notificationDecisions = [
  "approved",
  "declined",
  "rejected",
  "accepted",
  "awaiting_manager",
  "confirmed",
  "refused",
] as const;
export type NotificationDecision = (typeof notificationDecisions)[number];

/** One notification as the notification centre shows it. Client-safe. */
export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  /** The source Home; null for notices about the account or a Home the person is not in. */
  readonly homeId: string | null;
  readonly homeName: string | null;
  /** Dates and codes only (never free text); the words come from the reader's language. */
  readonly objectionEndsAt: string | null;
  readonly decision: NotificationDecision | null;
  /** Why a chore claim was released (S21): automatically, or by a chore manager. */
  readonly reason: "auto" | "manager" | null;
  /** The chore occurrence a claim or reassignment notice is about (S21). */
  readonly occurrenceId: string | null;
  /** A reminder's task (S19b), its due day, and its title when the reader can still see it. */
  readonly taskId: string | null;
  readonly dueDate: string | null;
  readonly taskTitle: string | null;
  /**
   * A habit reminder's or pause notice's habit (S28) and its name when the reader can still see it;
   * the day a reminder is for, whether the habit is weekly, and when a pause ends.
   */
  readonly habitId: string | null;
  readonly habitName: string | null;
  /**
   * A goal's deadline reminder (S30): the goal and its title when the reader can still see it,
   * whether it is the advance or the overdue reminder, and the deadline.
   */
  readonly goalId: string | null;
  readonly goalName: string | null;
  readonly goalReminder: "lead" | "overdue" | null;
  readonly deadline: string | null;
  readonly onDate: string | null;
  readonly weekly: boolean;
  /** A numeric habit's progress when a reminder was sent (S29); null for other habits. */
  readonly progress: {
    readonly total: number;
    readonly target: number;
    readonly unit: string;
    readonly unitKind: "preset" | "custom";
  } | null;
  readonly resumesOn: string | null;
  /** A pause notice sent because a dated pause ended by itself. */
  readonly automatic: boolean;
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
