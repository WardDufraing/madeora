"use client";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { shoppingKeys } from "@/shopping/format";

/** Changes that arrive close together become one refresh. */
const REFRESH_DELAY_MS = 300;

/** While the tab is visible the stored version is also read this often: delivery is not assumed. */
const RECONCILE_INTERVAL_MS = 5_000;

export interface ShoppingLiveProps {
  /** The context's signal row: a Home's id, or the person's own user id for the Personal space. */
  readonly contextId: string;
  /** The version the page was rendered at (null: unknown, refresh on connect). */
  readonly version: number | null;
  /** Re-render the server page too (pages); widgets only re-read their queries. */
  readonly refreshPage?: boolean;
}

/**
 * Keeps a context's shopping views current while they are open (S26; the ADR 0027 approach). It
 * subscribes to the context's signal row only: Realtime delivers it to current members of that
 * Home, or to the Personal space's owner (RLS), and it carries a version number, never shopping
 * content. When the version moves past what the view shows, it re-reads everything with the
 * person's own session, so an item someone else just checked off moves to Completed without a
 * reload.
 *
 * Delivery and order are not trusted: on (re)connecting, when the tab becomes visible again and
 * every few seconds while it is visible, it compares the stored version with the rendered one, so
 * a missed event delays an update instead of losing it. The subscription ends when the view
 * unmounts, the context changes or the person signs out.
 */
export function ShoppingLive({ contextId, version, refreshPage = true }: ShoppingLiveProps) {
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
        void queryClient.invalidateQueries({ queryKey: shoppingKeys.all });
        if (refreshPage) {
          startTransition(() => {
            router.refresh();
          });
        }
      }, REFRESH_DELAY_MS);
    };
    const check = async () => {
      const { data, error } = await supabase
        .from("shopping_signals")
        .select("version")
        .eq("context_id", contextId)
        .maybeSingle();
      // Unreadable (offline, session ending): the next event or visibility change tries again.
      if (error) return;
      refreshIfNewer(data?.version ?? 0);
    };
    const channel = supabase
      .channel(`shopping:${contextId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shopping_signals",
          filter: `context_id=eq.${contextId}`,
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
  }, [contextId, queryClient, refreshPage, router]);

  return null;
}
