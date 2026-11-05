/**
 * The Google Calendar sync's view of Postgres (S33): the service-role `google_sync_*` functions of the
 * S33 migration, through `supabase.rpc()`. Each rechecks the connection's lease and the calendar's
 * state itself; answers are checked against their shape. Errors carry the Postgres code only.
 */
import {
  changeFields,
  repeatFrequencies,
  type BeginResult,
  type NormalizedCalendar,
  type NormalizedEvent,
  type PushAnswer,
  type PushChange,
  type SyncCalendar,
  type SyncStore,
} from "@madeora/google-calendar";
import type { Json } from "@madeora/database";
import { z } from "zod";

import { JobStoreError, type JobsSupabaseClient } from "./supabase-store.ts";

const beginAnswer = z.union([
  z.object({ outcome: z.literal("ok"), userId: z.uuid(), token: z.string() }),
  z.object({ outcome: z.enum(["missing", "expired", "inactive", "busy"]) }),
]);

const calendarsAnswer = z
  .array(
    z.object({
      id: z.uuid(),
      googleId: z.string(),
      syncToken: z.string().nullable(),
      fullDue: z.boolean(),
    }),
  )
  .nullable();

const snapshot = z
  .object({
    etag: z.string().nullable().optional(),
    deleted: z.boolean().optional(),
    title: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    allDay: z.boolean().optional(),
    startsOn: z.string().nullable().optional(),
    endsOn: z.string().nullable().optional(),
    startsAt: z.string().nullable().optional(),
    endsAt: z.string().nullable().optional(),
    timeZone: z.string().nullable().optional(),
    originalStart: z.string().nullable().optional(),
    recurringEventId: z.string().nullable().optional(),
  })
  .transform((value) =>
    // exactOptionalPropertyTypes: drop keys zod filled with undefined.
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)),
  );

const fields = z.array(z.enum(changeFields));
const actions = z.enum(["create", "update", "delete"]);

const changesAnswer = z
  .array(
    z.object({
      id: z.uuid(),
      version: z.int().positive(),
      googleCalendarId: z.string().min(1),
      calendarTimeZone: z.string().nullable(),
      action: actions,
      scope: z.enum(["event", "following", "all"]),
      googleEventId: z.string().min(1),
      seriesId: z.string().nullable(),
      fields,
      base: snapshot.nullable(),
      mine: snapshot.nullable(),
      repeat: z
        .object({
          frequency: z.enum(repeatFrequencies),
          interval: z.int().min(1).max(99),
          weekdays: z.array(z.int().min(1).max(7)).nullable(),
          endsOn: z.string().nullable(),
          count: z.int().min(1).nullable(),
        })
        .nullable(),
    }),
  )
  .nullable();

const resultAnswer = z
  .union([
    z.object({
      state: z.literal("pending"),
      version: z.int().positive(),
      base: snapshot,
      mine: snapshot.nullable(),
      fields,
      action: actions,
    }),
    z.object({ state: z.string() }),
  ])
  .nullable();

export function createGoogleSyncStore(client: JobsSupabaseClient): SyncStore {
  return {
    async begin(connectionId, lease, leaseSeconds): Promise<BeginResult> {
      const { data, error } = await client.rpc("google_sync_begin", {
        p_connection_id: connectionId,
        p_lease: lease,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new JobStoreError("google_sync_begin", error.code);
      const parsed = beginAnswer.safeParse(data);
      if (!parsed.success) throw new JobStoreError("google_sync_begin", "unexpected_result");
      return parsed.data;
    },

    async applyCalendars(
      connectionId: string,
      lease: string,
      calendars: readonly NormalizedCalendar[],
    ): Promise<readonly SyncCalendar[] | null> {
      const { data, error } = await client.rpc("google_sync_calendars", {
        p_connection_id: connectionId,
        p_lease: lease,
        p_calendars: calendars.map((c) => ({ ...c })),
      });
      if (error) throw new JobStoreError("google_sync_calendars", error.code);
      const parsed = calendarsAnswer.safeParse(data);
      if (!parsed.success) throw new JobStoreError("google_sync_calendars", "unexpected_result");
      return parsed.data;
    },

    async applyEvents(
      calendarId: string,
      lease: string,
      full: boolean,
      events: readonly NormalizedEvent[],
    ): Promise<number | null> {
      const { data, error } = await client.rpc("google_sync_apply_events", {
        p_calendar_id: calendarId,
        p_lease: lease,
        p_full: full,
        p_events: events.map((e) => ({ ...e })),
      });
      if (error) throw new JobStoreError("google_sync_apply_events", error.code);
      const parsed = z.int().nonnegative().nullable().safeParse(data);
      if (!parsed.success) throw new JobStoreError("google_sync_apply_events", "unexpected_result");
      return parsed.data;
    },

    async finishCalendar(calendarId, lease, full, syncToken, failure) {
      const { data, error } = await client.rpc("google_sync_finish_calendar", {
        p_calendar_id: calendarId,
        p_lease: lease,
        p_full: full,
        ...(syncToken === null ? {} : { p_sync_token: syncToken }),
        ...(failure === null ? {} : { p_error: failure }),
      });
      if (error) throw new JobStoreError("google_sync_finish_calendar", error.code);
      return data;
    },

    async pushChanges(connectionId, lease): Promise<readonly PushChange[] | null> {
      const { data, error } = await client.rpc("google_push_changes", {
        p_connection_id: connectionId,
        p_lease: lease,
      });
      if (error) throw new JobStoreError("google_push_changes", error.code);
      const parsed = changesAnswer.safeParse(data);
      if (!parsed.success) throw new JobStoreError("google_push_changes", "unexpected_result");
      return parsed.data;
    },

    async pushResult(changeId, lease, version, result): Promise<PushAnswer | null> {
      const { data, error } = await client.rpc("google_push_result", {
        p_change_id: changeId,
        p_lease: lease,
        p_version: version,
        p_result: JSON.parse(JSON.stringify(result)) as Json,
      });
      if (error) throw new JobStoreError("google_push_result", error.code);
      const parsed = resultAnswer.safeParse(data);
      if (!parsed.success) throw new JobStoreError("google_push_result", "unexpected_result");
      return parsed.data;
    },

    async finish(connectionId, lease, outcome) {
      const { data, error } = await client.rpc("google_sync_finish", {
        p_connection_id: connectionId,
        p_lease: lease,
        p_outcome: outcome,
      });
      if (error) throw new JobStoreError("google_sync_finish", error.code);
      return data;
    },
  };
}
