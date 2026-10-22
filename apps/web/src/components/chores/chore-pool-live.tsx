"use client";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { choreKeys } from "@/chores/format";

/** Changes that arrive close together become one refresh. */
const REFRESH_DELAY_MS = 300;

/** While the tab is visible the stored version is also read this often: delivery is not assumed. */
const RECONCILE_INTERVAL_MS = 5_000;

export interface ChorePoolLiveProps {
  readonly homeId: string;
  /** The Home's pool signal version the page was rendered at (null: unknown, refresh on connect). */
  readonly version: number | null;
}

/**
 * Keeps a Home's chore pages current while they are open (S21, ADR 0027; architecture.md §8
 * Realtime C). It subscribes to the Home's signal row only: Realtime delivers it to current
 * members of that Home (RLS), and it carries a version number, never chore content. When the
 * version moves past what the page shows, the page re-reads everything from the server with the
 * person's own session; a claim someone else just made therefore shows without reloading.
 *
 * Delivery and order are not trusted: on (re)connecting and when the tab becomes visible again it
 * compares the stored version with the rendered one, so a change missed between rendering and
 * subscribing, or while offline, still shows. While the tab is visible it also compares them every
 * few seconds, so a dropped or never-delivered event delays an update instead of losing it. The
 * subscription ends when the view unmounts, the Home changes, or the person signs out (the shell
 * then re-renders without it).
 */
export function ChorePoolLive({ homeId, version }: ChorePoolLiveProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [, startTransition] = useTransition();
  const shown = useRef(version);

  useEffect(() => {
    shown.current = version;
  }, [version]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const refreshIfNewer = (next: number | null) => {
      if (!active || (next !== null && shown.current !== null && next <= shown.current)) return;
      if (next !== null) shown.current = next;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: choreKeys.all });
        startTransition(() => {
          router.refresh();
        });
      }, REFRESH_DELAY_MS);
    };
    const check = async () => {
      const { data, error } = await supabase
        .from("chore_pool_signals")
        .select("version")
        .eq("home_id", homeId)
        .maybeSingle();
      // Unreadable (offline, session ending): the next event or visibility change tries again.
      if (error) return;
      refreshIfNewer(data?.version ?? 0);
    };
    const channel = supabase
      .channel(`chore-pool:${homeId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chore_pool_signals",
          filter: `home_id=eq.${homeId}`,
        },
        (payload) => {
          const next: unknown = (payload.new as Record<string, unknown> | undefined)?.version;
          refreshIfNewer(typeof next === "number" ? next : null);
        },
      )
      .subscribe((status) => {
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) void check();
      });
    const checkIfVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", checkIfVisible);
    const reconcile = setInterval(checkIfVisible, RECONCILE_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(reconcile);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkIfVisible);
      void supabase.removeChannel(channel);
    };
  }, [homeId, queryClient, router]);

  return null;
}
