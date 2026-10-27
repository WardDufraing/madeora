"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { RecipeRequestError } from "@/recipes/api";
import { recipeKeys } from "@/recipes/format";

/**
 * A recipe change: sends it, then refreshes the server-rendered page and drops cached recipe
 * reads, so every view shows the database's state. A signed-out or no-longer-visible answer
 * refreshes too, so the page sends the person where they belong. `scope` serializes changes to
 * one record, so a double click cannot race itself.
 */
export function useRecipeMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
  options: { readonly refresh?: boolean } = {},
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const refresh = options.refresh ?? true;
  const mutation = useMutation<Output, RecipeRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof RecipeRequestError ? error : new RecipeRequestError("failed");
      }
    },
    scope: { id: scope },
    onSuccess: (output, input) => {
      onSuccess?.(output, input);
      void queryClient.invalidateQueries({ queryKey: recipeKeys.all });
      if (refresh) {
        startTransition(() => {
          router.refresh();
        });
      }
    },
    onError: (error) => {
      if (error.failure === "signedOut" || error.failure === "notFound") {
        startTransition(() => {
          router.refresh();
        });
      }
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}
