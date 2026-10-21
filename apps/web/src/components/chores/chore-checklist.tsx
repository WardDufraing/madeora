"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Checkbox } from "@/components/ui/checkbox";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreOccurrenceDetail,
  type StepResponse,
} from "@/chores/api";
import { noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

/**
 * The occurrence's own checklist (S20): any member ticks and unticks its steps while it is open;
 * required steps say so in text. A completed or skipped occurrence keeps its checklist as part of
 * the record, read only.
 */
export function ChoreChecklist({ occurrence }: { readonly occurrence: ChoreOccurrenceDetail }) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  // Shown at once; the server's answer (or a refresh) replaces it.
  const [pending, setPending] = useState<Readonly<Record<string, boolean>>>({});
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrence.id}:steps`,
    (input: { stepId: string; checked: boolean }) =>
      sendChoreRequest<StepResponse>(
        "PUT",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrence.id}/steps/${input.stepId}`,
        { checked: input.checked },
      ),
    (result) => {
      announce(t("stepsProgress", { done: result.done, total: result.total }));
    },
  );
  if (occurrence.steps.length === 0) return null;
  const open = occurrence.status === "open";
  const checkedOf = (id: string, checked: boolean) => pending[id] ?? checked;
  const done = occurrence.steps.filter((step) => checkedOf(step.id, step.checked)).length;

  return (
    <section aria-labelledby="chore-checklist-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-checklist-heading" className="text-section-title font-semibold text-fg">
          {t("checklistHeading")}{" "}
          <span className="text-body font-normal text-fg-muted">
            {t("stepsProgress", { done, total: occurrence.steps.length })}
          </span>
        </h2>
        <ul className="flex flex-col gap-1" data-testid="chore-checklist">
          {occurrence.steps.map((step) => (
            <li key={step.id}>
              <Checkbox
                label={step.label}
                {...(step.mandatory ? { description: t("stepRequired") } : {})}
                checked={checkedOf(step.id, step.checked)}
                disabled={!open}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setPending((current) => ({ ...current, [step.id]: checked }));
                  mutation.mutate(
                    { stepId: step.id, checked },
                    {
                      onError: () => {
                        setPending((current) =>
                          Object.fromEntries(
                            Object.entries(current).filter(([id]) => id !== step.id),
                          ),
                        );
                      },
                    },
                  );
                }}
              />
            </li>
          ))}
        </ul>
        {!open ? <p className="text-helper text-fg-muted">{t("checklistClosed")}</p> : null}
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
      </HydrationGate>
    </section>
  );
}
