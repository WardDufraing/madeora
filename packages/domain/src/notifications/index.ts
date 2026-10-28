/**
 * What a notification is, shared by the database's triggers (which write the `kind` codes), the
 * email jobs, and the web app's notification centre (S14). Pure and framework-free.
 *
 * A kind names an event for one kind of reader ("recovery.claimant_ready" is for the person who
 * asked for a recovery), so the words and the link can differ per reader without the notification
 * carrying any text. The kinds here must match the codes in
 * `supabase/migrations/*_notifications.sql`; a database test lists what the triggers write.
 */

export const notificationCategories = [
  "security",
  "invitations",
  "storage",
  "reminders",
  "approvals",
  "chores",
  "points",
  "rewards",
  "habits",
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];

/** Categories a person can configure; the others are essential and cannot be switched off. */
export const optionalNotificationCategories = [
  "invitations",
  "reminders",
  "approvals",
  "chores",
  "points",
  "rewards",
  "habits",
] as const;
export type OptionalNotificationCategory = (typeof optionalNotificationCategories)[number];

export const notificationChannels = ["in_app", "email"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

export const notificationKinds = [
  "recovery.owner_requested",
  "recovery.owner_review_started",
  "recovery.owner_approved",
  "recovery.claimant_review_started",
  "recovery.claimant_approved",
  "recovery.claimant_paused",
  "recovery.claimant_resumed",
  "recovery.claimant_rejected",
  "recovery.claimant_ended_owner_access",
  "recovery.claimant_invalid",
  "recovery.claimant_completed",
  "recovery.claimant_ready",
  "recovery.member_requested",
  "recovery.member_objection_open",
  "recovery.member_ended",
  "recovery.member_completed",
  "recovery.former_owner_completed",
  "recovery.former_owner_completed_removed",
  "join_request.received",
  "join_request.decided",
  "storage.personal_warning",
  "storage.personal_critical",
  "storage.home_warning",
  "storage.home_critical",
  "task.reminder",
  "chore.approval_requested",
  "chore.claim_released",
  "chore.reassignment_requested",
  "chore.reassignment_answered",
  "chore.reassignment_confirmation_needed",
  "chore.reassignment_decided",
  "chore.reassignment_invalidated",
  "chore.proposal_decided",
  "chore.volunteer_invited",
  "chore.volunteer_accepted",
  "chore.assignment_corrected",
  "chore.reminder",
  "chore.manager_summary",
  "vacation.invited",
  "vacation.dates_proposed",
  "vacation.reminder",
  "points.awarded",
  "points.reversed",
  "points.bonus",
  "points.corrected",
  "points.adjustment_reversed",
  "reward.requested",
  "reward.approved",
  "reward.rejected",
  "reward.cancelled",
  "reward.fulfilled",
  "reward.unable",
  "reward.refunded",
  "reward.replacement",
  "habit.reminder",
  "habit.paused",
  "habit.resumed",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (notificationKinds as readonly string[]).includes(value);
}

/** The page in the app a notification leads to (also the target of its email's button). */
export function notificationPath(
  kind: string,
  homeId: string | null,
  params: Readonly<Record<string, unknown>> = {},
): string {
  if (kind === "task.reminder") {
    const taskId = typeof params.taskId === "string" ? encodeURIComponent(params.taskId) : null;
    const base = homeId ? `/homes/${encodeURIComponent(homeId)}/tasks` : "/tasks";
    return taskId ? `${base}/${taskId}` : base;
  }
  // S28: habit reminders and pause notices lead to the habit, in its Home or the personal space.
  if (kind.startsWith("habit.")) {
    const habitId = typeof params.habitId === "string" ? encodeURIComponent(params.habitId) : null;
    const base = homeId ? `/homes/${encodeURIComponent(homeId)}/habits` : "/habits";
    return habitId ? `${base}/${habitId}` : base;
  }
  if (
    kind === "recovery.former_owner_completed" ||
    kind === "recovery.former_owner_completed_removed"
  ) {
    return "/settings/recoveries";
  }
  if (kind.startsWith("join_request.decided")) return "/";
  if (kind.startsWith("storage.personal_")) return "/settings/storage";
  if (!homeId) return "/";
  const home = `/homes/${encodeURIComponent(homeId)}`;
  if (kind === "join_request.received") return `${home}/invitations`;
  if (kind.startsWith("storage.home_")) return `${home}/storage`;
  if (kind === "chore.approval_requested") return `${home}/chores/approvals`;
  if (kind === "chore.proposal_decided") return `${home}/chores/proposals`;
  if (kind === "chore.manager_summary") return `${home}/chores/summary`;
  // S22: invitations and date proposals are answered on the Vacations page; the reminder leads to
  // the vacation and its affected chores.
  if (kind === "vacation.invited" || kind === "vacation.dates_proposed") return `${home}/vacations`;
  if (kind === "vacation.reminder") {
    const vacationId =
      typeof params.vacationId === "string" ? encodeURIComponent(params.vacationId) : null;
    return vacationId ? `${home}/vacations/${vacationId}` : `${home}/vacations`;
  }
  // S23: points notices lead to the person's points, reward notices to the rewards page (a request
  // to review it, the rest to the requester's own requests).
  if (kind.startsWith("points.")) return `${home}/points`;
  if (kind === "reward.requested") return `${home}/rewards/approvals`;
  if (kind.startsWith("reward.")) return `${home}/rewards`;
  if (kind.startsWith("chore.")) {
    // Claims, reassignment and volunteer requests and reminders (S21) lead to their occurrence.
    const occurrenceId =
      typeof params.occurrenceId === "string" ? encodeURIComponent(params.occurrenceId) : null;
    return occurrenceId ? `${home}/chores/${occurrenceId}` : `${home}/chores`;
  }
  if (
    kind === "recovery.claimant_review_started" ||
    kind === "recovery.claimant_approved" ||
    kind === "recovery.claimant_paused" ||
    kind === "recovery.claimant_resumed" ||
    kind === "recovery.claimant_ready"
  ) {
    return `${home}/recovery`;
  }
  return home;
}
