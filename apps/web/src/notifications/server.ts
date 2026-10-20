import "server-only";

import {
  notificationChannels,
  optionalNotificationCategories,
} from "@madeora/domain/notifications";
import { cache } from "react";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import type { NotificationView, PreferenceRow, QuietHoursRow } from "./types";

/**
 * Reads for the notification centre and its settings (S14). Every read uses the person's own
 * session, so RLS shows only their rows, and only for Homes they still belong to. Rows are checked
 * here before they reach a page, so a schema drift fails closed (the row is dropped).
 */

export type Loaded<T> =
  { readonly status: "ok"; readonly value: T } | { readonly status: "unavailable" };

function logFailure(event: string, code: string | undefined): void {
  // Privacy-safe: the error code only.
  console.error(JSON.stringify({ event, code }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The titles of the tasks the reminders are about, read now and only for tasks the reader can still
 * see (S19b): a notification never stores the title, so a renamed task shows its new title and a
 * task the reader lost access to shows none. Empty when they cannot be read.
 */
async function reminderTitles(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  rows: readonly { kind: string; params: unknown }[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        row.kind === "task.reminder" &&
        isRecord(row.params) &&
        typeof row.params.taskId === "string"
          ? [row.params.taskId]
          : [],
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.rpc("task_reminder_titles", { p_task_ids: ids });
  if (error) {
    logFailure("notifications.task_titles_failed", error.code);
    return new Map();
  }
  return new Map(data.map((row) => [row.task_id, row.title]));
}

/** The newest notifications, 50 at most. */
export const listNotifications = cache(async (): Promise<Loaded<readonly NotificationView[]>> => {
  if (!(await getVerifiedIdentity())) return { status: "ok", value: [] };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("id, home_id, kind, params, during_quiet_hours, created_at, read_at, homes(name)")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    logFailure("notifications.list_failed", error.code);
    return { status: "unavailable" };
  }
  const items: NotificationView[] = [];
  const titles = await reminderTitles(supabase, data);
  for (const row of data) {
    const params = isRecord(row.params) ? row.params : {};
    const embedded: unknown = row.homes;
    const home: unknown = Array.isArray(embedded) ? (embedded[0] as unknown) : embedded;
    items.push({
      id: row.id,
      kind: row.kind,
      homeId: row.home_id,
      homeName: isRecord(home) && typeof home.name === "string" ? home.name : null,
      objectionEndsAt: typeof params.objectionEndsAt === "string" ? params.objectionEndsAt : null,
      decision:
        params.decision === "approved" || params.decision === "declined" ? params.decision : null,
      taskId: typeof params.taskId === "string" ? params.taskId : null,
      dueDate: typeof params.dueDate === "string" ? params.dueDate : null,
      taskTitle: typeof params.taskId === "string" ? (titles.get(params.taskId) ?? null) : null,
      duringQuietHours: row.during_quiet_hours,
      createdAt: row.created_at,
      readAt: row.read_at,
    });
  }
  return { status: "ok", value: items };
});

/** How many notifications are unread; 0 when they cannot be counted (the bell then shows none). */
export const countUnreadNotifications = cache(async (): Promise<number> => {
  if (!(await getVerifiedIdentity())) return 0;
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  if (error) {
    logFailure("notifications.count_failed", error.code);
    return 0;
  }
  return count ?? 0;
});

export interface NotificationSettingsView {
  readonly emailVerified: boolean;
  readonly preferences: readonly PreferenceRow[];
  readonly quietHours: readonly QuietHoursRow[];
}

function oneOf<T extends string>(list: readonly T[], value: string): T | null {
  return list.find((item) => item === value) ?? null;
}

/** `HH:MM:SS` from the database as `HH:MM`. */
function clock(value: string): string {
  return value.slice(0, 5);
}

/** The person's effective choices (account and each Home) and their stored quiet hours. */
export const getNotificationSettings = cache(
  async (): Promise<Loaded<NotificationSettingsView>> => {
    const supabase = await createSupabaseServerClient();
    const [settings, channels, quiet] = await Promise.all([
      supabase.rpc("get_notification_settings"),
      supabase.rpc("my_notification_channels"),
      supabase
        .from("notification_quiet_hours")
        .select("home_id, enabled, start_time, end_time, time_zone"),
    ]);
    if (settings.error || channels.error || quiet.error) {
      logFailure(
        "notifications.settings_failed",
        settings.error?.code ?? channels.error?.code ?? quiet.error?.code,
      );
      return { status: "unavailable" };
    }
    const preferences: PreferenceRow[] = [];
    for (const row of settings.data) {
      const category = oneOf(optionalNotificationCategories, row.category);
      const channel = oneOf(notificationChannels, row.channel);
      if (!category || !channel) continue;
      preferences.push({
        homeId: row.home_id,
        category,
        channel,
        enabled: row.enabled,
        overridden: row.overridden,
      });
    }
    return {
      status: "ok",
      value: {
        emailVerified: channels.data[0]?.email_verified === true,
        preferences,
        quietHours: quiet.data.map((row) => ({
          homeId: row.home_id,
          enabled: row.enabled,
          start: clock(row.start_time),
          end: clock(row.end_time),
          timeZone: row.time_zone,
        })),
      },
    };
  },
);
