"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { HabitRequestError } from "@/habits/api";
import { habitKeys } from "@/habits/format";

/**
 * A habit change: sends it, then drops cached habit reads and refreshes the server-rendered page,
 * so every view shows the database's state. A signed-out, no-longer-visible or conflicting answer
 * refreshes too, so the page shows what is true now instead of overwriting it. `scope` serializes
 * changes to one record, so a double click cannot race itself.
 */
export function useHabitMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: habitKeys.all });
    startTransition(() => {
      router.refresh();
    });
  };
  const mutation = useMutation<Output, HabitRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof HabitRequestError ? error : new HabitRequestError("failed");
      }
    },
    scope: { id: scope },
    onSuccess: (output, input) => {
      onSuccess?.(output, input);
      refresh();
    },
    onError: (error) => {
      // Anything but a network or input problem means the page is out of date: show what is true.
      if (
        error.failure !== "network" &&
        error.failure !== "invalid" &&
        error.failure !== "failed"
      ) {
        refresh();
      }
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}
