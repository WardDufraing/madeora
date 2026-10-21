"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreOccurrenceDetail,
  type DeleteImpact,
  type DeleteResponse,
} from "@/chores/api";
import { choresPath } from "@/chores/format";
import type { DeleteScope } from "@/chores/schema";
import { noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

/**
 * Deleting (S20, chore managers): a one-off chore as a whole; for a recurring one this occurrence,
 * this and following (the schedule ends the day before), or the entire series (the chore ends).
 * Everything goes to the Home's trash; completed and skipped occurrences always stay as history.
 * The server previews what goes before anything is removed.
 */
export function ChoreDelete({
  occurrence,
  homeId,
}: {
  readonly occurrence: ChoreOccurrenceDetail;
  readonly homeId: string;
}) {
  const t = useTranslations("Chores");
  const router = useRouter();
  const texts = useChoreTexts(noMembers);
  const radio = useId();
  const recurring = occurrence.chore.kind === "recurring";
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<DeleteScope>("occurrence");
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrence.id}`,
    (input: { scope: DeleteScope; dryRun: boolean }) =>
      sendChoreRequest<DeleteResponse>(
        "POST",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrence.id}/delete`,
        {
          ...input,
          expectedRevision: occurrence.revision,
        },
      ),
    (result, input) => {
      if (input.dryRun) {
        setImpact(result.impact);
        return;
      }
      setOpen(false);
      router.push(`${choresPath(homeId)}?deleted=1`);
    },
    { refresh: () => false },
  );
  const choose = (value: DeleteScope) => {
    setScope(value);
    setImpact(null);
    mutation.reset();
    mutation.mutate({ scope: value, dryRun: true });
  };

  return (
    <section aria-labelledby="chore-delete-heading" className="flex flex-col gap-3">
      <HydrationGate>
        <h2 id="chore-delete-heading" className="text-section-title font-semibold text-fg">
          {t("deleteHeading")}
        </h2>
        <div>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(true);
              choose("occurrence");
            }}
            data-testid="chore-delete-open"
          >
            {recurring ? t("deleteOccurrences") : t("deleteChore")}
          </Button>
        </div>
        <Dialog
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          title={recurring ? t("deleteOccurrencesTitle") : t("deleteChoreTitle")}
          description={t("deleteBody")}
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                loading={mutation.busy}
                disabled={impact === null}
                onClick={() => {
                  mutation.mutate({ scope, dryRun: false });
                }}
                data-testid="chore-delete-confirm"
              >
                {t("moveToTrash")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {recurring ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="text-body font-medium text-fg">{t("scopeLegend")}</legend>
                <RadioOption
                  name={radio}
                  value="occurrence"
                  label={t("scopeOccurrence")}
                  checked={scope === "occurrence"}
                  onChange={() => {
                    choose("occurrence");
                  }}
                />
                {occurrence.schedule?.inHead ? (
                  <RadioOption
                    name={radio}
                    value="following"
                    label={t("scopeFollowing")}
                    checked={scope === "following"}
                    onChange={() => {
                      choose("following");
                    }}
                  />
                ) : null}
                <RadioOption
                  name={radio}
                  value="series"
                  label={t("scopeSeries")}
                  description={t("deleteSeriesHelp")}
                  checked={scope === "series"}
                  onChange={() => {
                    choose("series");
                  }}
                />
              </fieldset>
            ) : null}
            <p className="text-body text-fg" aria-live="polite" data-testid="chore-delete-impact">
              {impact
                ? impact.scope === "chore"
                  ? t("deleteImpactChore")
                  : t("deleteImpact", { removed: impact.removed, kept: impact.kept })
                : t("previewLoading")}
            </p>
            {mutation.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(mutation.error.failure)}
              </FormAlert>
            ) : null}
          </div>
        </Dialog>
      </HydrationGate>
    </section>
  );
}
