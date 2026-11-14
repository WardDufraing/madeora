import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { loadOverview } from "@/ora/overview/server";
import type { OraToolContext } from "@/ora/tools/types";

import type { OraSuggestion, SuggestionKind } from "./types";

/**
 * Ora's contextual suggestions for the person and place the server resolved (S47). Every source is
 * an existing overview read made with the person's own session, so a suggestion can only be about
 * things the person may see here, and nothing from another Home or the Personal space can enter.
 * A dismissal is remembered per person, place and kind; the same situation stays quiet.
 */

const scopeOf = (context: OraToolContext) => context.home?.id ?? "personal";

export type SuggestionsLoad =
  | {
      readonly status: "ok";
      /** The person's local date in this place, for the teaser day. */
      readonly today: string;
      readonly suggestions: readonly OraSuggestion[];
    }
  | { readonly status: "unavailable" };

export async function loadSuggestions(context: OraToolContext): Promise<SuggestionsLoad> {
  const loaded = await loadOverview(context, {
    target: "today",
    filters: { modules: [], assignee: "anyone", completion: "open" },
  });
  if (loaded.status !== "ok") return { status: "unavailable" };
  const { overview } = loaded;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("ora_dismissed_suggestions")
    .select("kind, situation")
    .eq("scope", scopeOf(context));
  if (error) {
    console.error(JSON.stringify({ event: "ora.suggestions_read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const dismissed = new Set(data.map((row) => `${row.kind}:${row.situation}`));

  const suggestions: OraSuggestion[] = [];
  // Only a complete reading can say "you have things today"; a partial one says nothing.
  if (!overview.incomplete) {
    const day = overview.days.find((candidate) => candidate.date === overview.today);
    const count = day ? day.timed.length + day.untimed.length : 0;
    const candidate: OraSuggestion = { kind: "today-overview", situation: overview.today, count };
    if (count > 0 && !dismissed.has(`${candidate.kind}:${candidate.situation}`)) {
      suggestions.push(candidate);
    }
  }
  return { status: "ok", today: overview.today, suggestions };
}

export type DismissResult = "ok" | "forbidden" | "failed";

/** Remembers that the person dismissed this suggestion here; the database limits it to their own row. */
export async function dismissSuggestion(
  context: OraToolContext,
  kind: SuggestionKind,
  situation: string,
): Promise<DismissResult> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("ora_dismissed_suggestions").upsert(
    {
      scope: scopeOf(context),
      home_id: context.home?.id ?? null,
      kind,
      situation,
      dismissed_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope,kind" },
  );
  if (error?.code === "42501") return "forbidden";
  if (error) {
    console.error(JSON.stringify({ event: "ora.suggestion_dismiss_failed", code: error.code }));
    return "failed";
  }
  return "ok";
}

export type TeaserResult =
  | { readonly status: "ok"; readonly teaser: OraSuggestion | null }
  | { readonly status: "unavailable" };

/**
 * The one unsolicited teaser a person may see per day, across Homes and devices. It is claimed in
 * the database (`claim_ora_teaser`) only when there is something to say, so a quiet day does not
 * use it up, and a mute or a second device cannot add another.
 */
export async function claimTeaser(context: OraToolContext): Promise<TeaserResult> {
  const loaded = await loadSuggestions(context);
  if (loaded.status !== "ok") return { status: "unavailable" };
  const first = loaded.suggestions[0];
  if (!first) return { status: "ok", teaser: null };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_ora_teaser", { p_today: loaded.today });
  if (error) {
    console.error(JSON.stringify({ event: "ora.teaser_claim_failed", code: error.code }));
    return { status: "unavailable" };
  }
  return { status: "ok", teaser: data ? first : null };
}
