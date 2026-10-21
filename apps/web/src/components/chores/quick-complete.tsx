"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { CHORE_OCCURRENCES_ENDPOINT, sendChoreRequest, type CompleteResponse } from "@/chores/api";
import { noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface QuickCompleteProps {
  readonly occurrenceId: string;
  readonly title: string;
  /** The viewer's own membership: they did it. */
  readonly contributor: string;
  /** The chore requires approval: this submits it (Pending approval), it does not complete it. */
  readonly requiresApproval?: boolean;
}

/**
 * Completing from the overview or a widget in one step (S20), offered only when nothing needs a
 * choice: no mandatory step is open and the viewer is the natural contributor. Anything else opens
 * the page. For a chore that requires approval it submits the completion and says so.
 */
export function QuickComplete({
  occurrenceId,
  title,
  contributor,
  requiresApproval = false,
}: QuickCompleteProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    () =>
      sendChoreRequest<CompleteResponse>(
        "PUT",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/completion`,
        { contributor, note: null },
      ),
    (result) => {
      announce(
        result.outcome === "already_completed"
          ? t("announceAlreadyCompleted")
          : result.outcome === "already_submitted"
            ? t("announceAlreadySubmitted")
            : result.outcome === "submitted"
              ? t("announceSubmitted", { title })
              : t("announceCompleted", { title }),
      );
    },
  );
  return (
    <HydrationGate>
      {region}
      <div className="flex flex-col items-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={mutation.busy}
          onClick={() => {
            mutation.mutate(undefined);
          }}
          aria-label={
            requiresApproval ? t("quickSubmitLabel", { title }) : t("quickCompleteLabel", { title })
          }
          data-testid="chore-quick-complete"
        >
          {requiresApproval ? t("markDoneForApproval") : t("markDone")}
        </Button>
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure, mutation.error.detail)}
          </FormAlert>
        ) : null}
      </div>
    </HydrationGate>
  );
}
