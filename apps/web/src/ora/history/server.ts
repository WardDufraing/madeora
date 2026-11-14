import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { OraToolContext } from "@/ora/tools/types";

import { historyKinds, type HistoryKind, type OraHistoryEntry } from "./types";

/**
 * The server half of Ora's seven-day history (S47b). Everything runs with the person's own session:
 * the database shows only their own rows, hides ones older than seven days, and hides a Home's rows
 * as soon as they stop being a member there.
 */

const scopeOf = (context: OraToolContext) => context.home?.id ?? "personal";

const isKind = (value: string): value is HistoryKind =>
  (historyKinds as readonly string[]).includes(value);

export type HistoryLoad =
  | { readonly status: "ok"; readonly entries: readonly OraHistoryEntry[] }
  | { readonly status: "unavailable" };

/** The newest entries made in this place, newest first. */
export async function loadHistory(context: OraToolContext): Promise<HistoryLoad> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("ora_interactions")
    .select("id, kind, label, created_at")
    .eq("scope", scopeOf(context))
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    console.error(JSON.stringify({ event: "ora.history_read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    entries: data.flatMap((row) =>
      isKind(row.kind)
        ? [{ id: row.id, kind: row.kind, label: row.label, createdAt: row.created_at }]
        : [],
    ),
  };
}

export type HistoryWrite = "ok" | "forbidden" | "failed";

export async function recordHistory(
  context: OraToolContext,
  kind: HistoryKind,
  label: string,
): Promise<HistoryWrite> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("ora_interactions").insert({
    scope: scopeOf(context),
    home_id: context.home?.id ?? null,
    kind,
    label,
  });
  if (error?.code === "42501") return "forbidden";
  if (error) {
    console.error(JSON.stringify({ event: "ora.history_write_failed", code: error.code }));
    return "failed";
  }
  return "ok";
}

/**
 * "Clear recent interactions": removes every history line of the signed-in person, in every place.
 * It touches nothing else (no task, item, memory or setting).
 */
export async function clearHistory(userId: string): Promise<HistoryWrite> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("ora_interactions").delete().eq("user_id", userId);
  if (error) {
    console.error(JSON.stringify({ event: "ora.history_clear_failed", code: error.code }));
    return "failed";
  }
  return "ok";
}
