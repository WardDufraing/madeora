"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { savePreferences, type PreferencesSaveError, type SaveFailure } from "@/preferences/api";
import type { PreferencesPatchInput, StoredPreferences } from "@/preferences/schema";

/**
 * Saves a preferences change through the API, then refreshes the server-rendered page so every
 * text, format and time follows at once without a full reload. All preference saves share one
 * mutation scope, so they reach the server in the order the person made them.
 */
export function useSavePreferences(onSaved?: (saved: StoredPreferences) => void) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation<StoredPreferences, PreferencesSaveError, PreferencesPatchInput>({
    mutationFn: savePreferences,
    scope: { id: "preferences" },
    onSuccess: (saved) => {
      onSaved?.(saved);
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error) => {
      // A session that ended elsewhere: the refreshed page sends the person to sign in.
      if (error.failure === "signedOut") router.refresh();
    },
  });
  const failure: SaveFailure | null = mutation.error?.failure ?? null;
  return { mutation, saving: mutation.isPending || refreshing, failure };
}
