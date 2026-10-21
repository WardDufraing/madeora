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
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];

/** Categories a person can configure; the others are essential and cannot be switched off. */
export const optionalNotificationCategories = ["invitations", "reminders", "approvals"] as const;
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
