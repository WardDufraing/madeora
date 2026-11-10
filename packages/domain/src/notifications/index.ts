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
  "goal.reminder",
  "pet_care.reminder",
  "calendar.reminder",
  "google_calendar.authorization_expired",
  "account.recovery_code_used",
  "account.recovery_codes_regenerated",
  "account.session_reported",
  "account.signed_out_everywhere",
  "account.device_trusted",
  "account.backup_email_changed",
  "account.backup_email_removed",
  "account.account_recovery_codes_created",
  "account.recovery_started",
  "account.recovered",
  "account.new_device_sign_in",
  "account.unfinished_sign_in",
  "account.signed_in",
  "account.security_report_ready",
  "account.deactivated",
  "account.reactivated",
  "account.inactivity_reminder",
  // S39: personal data exports (no link token, no details).
  "account.data_export_ready",
  "account.data_export_failed",
  "account.data_export_expiring",
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
  // S30: goal deadline reminders lead to the goal, in its Home or the personal space.
  if (kind.startsWith("goal.")) {
    const goalId = typeof params.goalId === "string" ? encodeURIComponent(params.goalId) : null;
    const base = homeId ? `/homes/${encodeURIComponent(homeId)}/goals` : "/goals";
    return goalId ? `${base}/${goalId}` : base;
  }
  // S31: a pet-care reminder leads to the activity on its pet's page.
  if (kind === "pet_care.reminder" && homeId) {
    const home = `/homes/${encodeURIComponent(homeId)}/pets`;
    const petId = typeof params.petId === "string" ? encodeURIComponent(params.petId) : null;
    const activityId =
      typeof params.activityId === "string" ? encodeURIComponent(params.activityId) : null;
    if (!petId) return home;
    return activityId ? `${home}/${petId}/care/${activityId}` : `${home}/${petId}`;
  }
  // S32: an event reminder leads to the occurrence, in its Home or the personal calendar.
  if (kind === "calendar.reminder") {
    const base = homeId ? `/homes/${encodeURIComponent(homeId)}/calendar` : "/calendar";
    const eventId = typeof params.eventId === "string" ? encodeURIComponent(params.eventId) : null;
    if (!eventId) return base;
    const on =
      typeof params.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.on) ? params.on : null;
    return `${base}/events/${eventId}${on ? `?on=${on}` : ""}`;
  }
  if (
    kind === "recovery.former_owner_completed" ||
    kind === "recovery.former_owner_completed_removed"
  ) {
    return "/settings/recoveries";
  }
  if (kind.startsWith("join_request.decided")) return "/";
  if (kind.startsWith("storage.personal_")) return "/settings/storage";
  // S33: an expired Google Calendar authorization leads to its settings, to reconnect.
  if (kind === "google_calendar.authorization_expired") return "/settings/google-calendar";
  // S38: sign-in alerts lead to Security activity, where "This was me" and "Secure my account"
  // are; a ready report to its section there.
  if (
    kind === "account.new_device_sign_in" ||
    kind === "account.unfinished_sign_in" ||
    kind === "account.signed_in"
  ) {
    return "/settings/security/activity";
  }
  if (kind === "account.security_report_ready") return "/settings/security/activity#report";
  // A Home export's notice carries its Home and leads to that Home's export page.
  if (kind.startsWith("account.data_export_")) {
    return homeId ? `/homes/${encodeURIComponent(homeId)}/export` : "/settings/privacy/export";
  }
  // S37: account security notices lead to Settings › Security.
  if (kind.startsWith("account.")) return "/settings/security";
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
