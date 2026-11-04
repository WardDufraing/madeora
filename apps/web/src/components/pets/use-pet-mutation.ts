"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { PetRequestError } from "@/pets/api";
import { petKeys } from "@/pets/format";

/**
 * A pets change: sends it, then drops cached pet reads and refreshes the server-rendered page, so
 * every view shows the database's state (including a medical access that changed meanwhile). A
 * refused or conflicting answer refreshes too. `scope` serializes changes to one record, so a
 * double click cannot race itself.
 */
export function usePetMutation<Input, Output>(
  scope: string,
  send: (input: Input) => Promise<Output>,
  onSuccess?: (output: Output, input: Input) => void,
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation<Output, PetRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof PetRequestError ? error : new PetRequestError("failed");
      }
    },
    scope: { id: scope },
    onSuccess: (output, input) => {
      onSuccess?.(output, input);
      void queryClient.invalidateQueries({ queryKey: petKeys.all });
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error) => {
      if (
        error.failure !== "network" &&
        error.failure !== "invalid" &&
        error.failure !== "failed"
      ) {
        void queryClient.invalidateQueries({ queryKey: petKeys.all });
        startTransition(() => {
          router.refresh();
        });
      }
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}
