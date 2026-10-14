"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { onSignedOutElsewhere } from "@/auth/broadcast";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";

export interface AuthSyncProps {
  /** The account the server confirmed for this page. */
  readonly userId: string;
}

/**
 * Keeps client caches tied to one account (architecture.md §7, §9). It empties the whole
 * TanStack Query cache when this tab signs out, another tab signs out, or a different account
 * appears, and then asks the server to re-check access. It also keeps the browser's Supabase
 * client running, which refreshes the session before it expires.
 */
export function AuthSync({ userId }: AuthSyncProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const confirmedUser = useRef(userId);

  useEffect(() => {
    if (confirmedUser.current !== userId) {
      confirmedUser.current = userId;
      queryClient.clear();
    }
  }, [userId, queryClient]);

  useEffect(() => {
    const reset = () => {
      queryClient.clear();
      router.refresh();
    };
    const stopListening = onSignedOutElsewhere(reset);
    const {
      data: { subscription },
    } = getSupabaseBrowserClient().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") reset();
      else if (session && session.user.id !== confirmedUser.current) reset();
    });
    return () => {
      stopListening();
      subscription.unsubscribe();
    };
  }, [queryClient, router]);

  return null;
}
