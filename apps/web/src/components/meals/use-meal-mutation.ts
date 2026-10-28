"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { MealRequestError } from "@/meals/api";
import { mealKeys } from "@/meals/format";

/**
 * A meal-planner change: sends it, then drops cached meal reads and refreshes the server-rendered
 * page, so every view shows the database's state. A signed-out, no-longer-visible or conflicting
 * answer refreshes too, so the page shows what is true now instead of overwriting it. `scope`
 * serializes changes to one record, so a double click cannot race itself.
 */
export function useMealMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: mealKeys.all });
    startTransition(() => {
      router.refresh();
    });
  };
  const mutation = useMutation<Output, MealRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof MealRequestError ? error : new MealRequestError("failed");
      }
    },
    scope: { id: scope },
    onSuccess: (output, input) => {
      onSuccess?.(output, input);
      refresh();
    },
    onError: (error) => {
      if (
        error.failure === "signedOut" ||
        error.failure === "notFound" ||
        error.failure === "conflict" ||
        error.failure === "notPermitted"
      ) {
        refresh();
      }
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}
