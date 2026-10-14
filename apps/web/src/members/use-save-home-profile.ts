"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import {
  saveHomeProfile,
  type HomeProfileSaveError,
  type HomeProfileSaveFailure,
} from "./profile-api";
import type { HomeProfileOverrides, HomeProfilePatchInput } from "./profile-schema";

/**
 * Saves a change to the person's own presentation in one Home, then refreshes the server-rendered
 * page so the preview, the directory and the Home's colour follow. Saves for one Home share a
 * mutation scope, so they reach the server in the order the person made them.
 */
export function useSaveHomeProfile(
  homeId: string,
  onSaved?: (saved: HomeProfileOverrides) => void,
) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation<HomeProfileOverrides, HomeProfileSaveError, HomeProfilePatchInput>({
    mutationFn: (patch) => saveHomeProfile(homeId, patch),
    scope: { id: `home-profile:${homeId}` },
    onSuccess: (saved) => {
      onSaved?.(saved);
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error) => {
      // Signed out elsewhere, or no longer a member: the refreshed page explains and redirects.
      if (error.failure === "signedOut" || error.failure === "notFound") router.refresh();
    },
  });
  const failure: HomeProfileSaveFailure | null = mutation.error?.failure ?? null;
  return { mutation, saving: mutation.isPending || refreshing, failure };
}
