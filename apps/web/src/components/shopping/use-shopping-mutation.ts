"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ShoppingRequestError } from "@/shopping/api";
import { shoppingKeys } from "@/shopping/format";

/**
 * A shopping change: sends it, then refreshes the server-rendered page and drops cached shopping
 * reads, so every view shows the database's state. A signed-out, no-longer-visible or conflicting
 * answer refreshes too, so the page shows what is true now instead of overwriting it. `scope`
 * serializes changes to one record, so a double click cannot race itself.
 */
export function useShoppingMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: shoppingKeys.all });
    startTransition(() => {
      router.refresh();
    });
  };
  const mutation = useMutation<Output, ShoppingRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof ShoppingRequestError ? error : new ShoppingRequestError("failed");
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
