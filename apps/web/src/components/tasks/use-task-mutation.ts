"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { TaskRequestError } from "@/tasks/api";
import { taskKeys } from "@/tasks/format";

/**
 * A task change: sends it, then refreshes the server-rendered page and drops cached task pages, so
 * every view shows the database's state; `onFailure` undoes anything shown early. A signed-out
 * or no-longer-visible answer refreshes too, so the page sends the person where they belong.
 * `scope` serializes changes to one record, so a double click cannot race itself.
 */
export function useTaskMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
  onFailure?: (input: Input) => void,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation<Output, TaskRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof TaskRequestError ? error : new TaskRequestError("failed");
      }
    },
    scope: { id: scope },
    onSuccess: (output, input) => {
      onSuccess?.(output, input);
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error, input) => {
      onFailure?.(input);
      if (error.failure === "signedOut" || error.failure === "notFound") {
        startTransition(() => {
          router.refresh();
        });
      }
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}
