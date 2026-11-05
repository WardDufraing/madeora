/**
 * The Google Calendar sync's view of Postgres (S33): the service-role `google_sync_*` functions of the
 * S33 migration, through `supabase.rpc()`. Each rechecks the connection's lease and the calendar's
 * state itself; answers are checked against their shape. Errors carry the Postgres code only.
 */
import type {
  BeginResult,
  NormalizedCalendar,
  NormalizedEvent,
  SyncCalendar,
  SyncStore,
} from "@madeora/google-calendar";
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
