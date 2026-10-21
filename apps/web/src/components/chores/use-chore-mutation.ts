"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ChoreRequestError, type ChoreFailure } from "@/chores/api";
import { choreKeys } from "@/chores/format";

/**
 * A chore change: sends it, then refreshes the server-rendered page and drops cached chore pages,
 * so every view shows the database's state. A signed-out or no-longer-visible answer refreshes too,
 * so the page sends the person where they belong. `scope` serializes changes to one record, so a
 * double click cannot race itself. `refresh: false` keeps the page as it is (a preview).
 */
export function useChoreMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
  options: {
    readonly refresh?: (output: Output, input: Input) => boolean;
    /** Failures after which the page is stale and refreshes too (a lost claim race, S21). */
    readonly refreshOnError?: (failure: ChoreFailure) => boolean;
    readonly onError?: (error: ChoreRequestError) => void;
  } = {},
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation<Output, ChoreRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof ChoreRequestError ? error : new ChoreRequestError("failed");
      }
    },
    scope: { id: scope },
    onSuccess: (output, input) => {
      onSuccess?.(output, input);
      if (options.refresh && !options.refresh(output, input)) return;
      void queryClient.invalidateQueries({ queryKey: choreKeys.all });
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error) => {
      options.onError?.(error);
      if (
        error.failure === "signedOut" ||
        error.failure === "notFound" ||
        options.refreshOnError?.(error.failure)
      ) {
        startTransition(() => {
          router.refresh();
        });
      }
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}
