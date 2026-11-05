import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { Read } from "@/calendar/data";
import { getEffectiveTimeZone } from "@/preferences/server";

import {
  googleConnectionSchema,
  googleEventSchema,
  type GoogleConnection,
  type GoogleEvent,
} from "./shapes";

/**
 * Server reads of Google Calendar (S33), always with the signed-in person's own session: the database
 * answers only their own connection, and a Google event only where they may see it now. Nothing is
 * cached across requests (personalized data).
 */

/** Logs by event and short code only: never ids, tokens, accounts, titles or times. */
export function logGoogleCalendar(event: string, code?: string): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/** The person's connection, or `null` when they have none. */
export async function readGoogleConnection(): Promise<Read<GoogleConnection | null>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_google_calendar_connection");
  if (error) {
    logGoogleCalendar("google_calendar.connection_failed", error.code);
    return { status: "unavailable" };
  }
  if (data === null) return { status: "ok", value: null };
  const parsed = googleConnectionSchema.safeParse(data);
  if (!parsed.success) {
    logGoogleCalendar("google_calendar.connection_failed", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

/** One Google event in a context (null: Personal). Not visible answers "not found". */
export async function readGoogleEvent(
  eventId: string,
  homeId: string | null,
): Promise<Read<GoogleEvent>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_google_calendar_event", {
    p_event_id: eventId,
    ...(homeId === null
      ? { p_zone: (await getEffectiveTimeZone()).timeZone }
      : { p_home_id: homeId }),
  });
  if (error) {
    if (error.code === "22P02") return { status: "not-found" };
    logGoogleCalendar("google_calendar.event_failed", error.code);
    return { status: "unavailable" };
  }
  if (data === null) return { status: "not-found" };
  const parsed = googleEventSchema.safeParse(data);
  if (!parsed.success) {
    logGoogleCalendar("google_calendar.event_failed", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}
