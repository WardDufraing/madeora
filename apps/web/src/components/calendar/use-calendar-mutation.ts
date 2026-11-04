"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { CalendarRequestError } from "@/calendar/api";
import { calendarKeys } from "@/calendar/format";

/**
 * A calendar change: sends it, then drops cached calendar reads and refreshes the server-rendered
 * page, so every view shows the database's state. A refused or conflicting answer refreshes too (a
 * level or share may have changed meanwhile). `scope` serializes changes to one event, so a double
 * click cannot race itself.
 */
export function useCalendarMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
    startTransition(() => {
      router.refresh();
    });
  };
  const mutation = useMutation<Output, CalendarRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof CalendarRequestError ? error : new CalendarRequestError("failed");
      }
    },
    scope: { id: scope },
    onSuccess: (output, input) => {
      onSuccess?.(output, input);
      refresh();
    },
    onError: (error) => {
      if (
        error.failure !== "network" &&
        error.failure !== "invalid" &&
        error.failure !== "failed" &&
        error.failure !== "nonexistentTime" &&
        error.failure !== "invalidDates"
      ) {
        refresh();
      }
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}
