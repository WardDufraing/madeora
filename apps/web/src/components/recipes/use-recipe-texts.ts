"use client";

import { useTranslations } from "next-intl";

import type { RecipeFailure } from "@/recipes/api";

const failureKey = {
  signedOut: "failureSignedOut",
  invalid: "failureInvalid",
  notFound: "failureNotFound",
  notPermitted: "failureNotPermitted",
  conflict: "failureConflict",
  incomplete: "failureIncomplete",
  limitReached: "failureLimitReached",
  invalidCover: "failureInvalidCover",
  storageFull: "failureStorageFull",
  lockLost: "failureLockLost",
  locked: "failureLocked",
  destinationUnavailable: "failureDestinationUnavailable",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<RecipeFailure, string>;

/** What a refused or failed recipe request means, in the viewer's language. */
export function useRecipeFailure(): (failure: RecipeFailure) => string {
  const t = useTranslations("Recipes");
  return (failure) => t(failureKey[failure]);
}
