"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { useToast } from "@/components/ui/toast";
import { CHORE_OCCURRENCES_ENDPOINT, ChoreRequestError, sendChoreRequest } from "@/chores/api";
import { choreKeys } from "@/chores/format";
import { noMembers } from "@/tasks/format";

import { useChoreTexts } from "./use-chore-texts";

/** How long the Undo stays offered after a claim (default picked: 10 seconds). */
export const CLAIM_UNDO_MS = 10_000;

/**
 * The toasts around a claim (S21): "claimed" with Undo for a short while, and what went wrong. They
 * live in the shell's toast region, so they stay when the claimed row leaves the list. Undo is a
 * release of the same claim, checked again by the database like any other.
 */
export function useClaimToasts() {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();

  const failed = useCallback(
    (error: unknown) => {
      const failure = error instanceof ChoreRequestError ? error.failure : "failed";
      toast.show({ title: texts.failure(failure), tone: "error" });
    },
    [texts, toast],
  );

  const claimed = useCallback(
    (occurrenceId: string, title: string) => {
      const undo = async () => {
        try {
          await sendChoreRequest("POST", `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/release`, {
            undo: true,
          });
          toast.show({ title: t("claimUndone", { title }) });
        } catch (error) {
          failed(error);
        }
        void queryClient.invalidateQueries({ queryKey: choreKeys.all });
        router.refresh();
      };
      toast.show({
        title: t("claimedToast", { title }),
        tone: "success",
        duration: CLAIM_UNDO_MS,
        action: {
          label: t("undo"),
          onAction: () => {
            void undo();
          },
        },
      });
    },
    [failed, queryClient, router, t, toast],
  );

  return { claimed, failed };
}
