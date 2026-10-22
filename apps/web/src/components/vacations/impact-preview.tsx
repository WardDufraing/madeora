"use client";

import { useTranslations } from "next-intl";

import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, type MemberNames } from "@/tasks/format";
import type { VacationImpact } from "@/vacations/api";
import { rangeText, rangesText } from "@/vacations/format";

import { useChoreTexts } from "@/components/chores/use-chore-texts";

/**
 * What a vacation change does to chores (S22), shown before it is confirmed and after it is saved:
 * the rotation turns that pass on or come back, occurrences paused or resumed, what is left for a
 * chore manager to review, and the Home-wide pause dates. Every line in words.
 */
export function ImpactPreview({
  impact,
  names,
  formats,
  testId = "vacation-impact",
}: {
  readonly impact: VacationImpact;
  readonly names: MemberNames;
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
  readonly testId?: string;
}) {
  const t = useTranslations("Vacations");
  const texts = useChoreTexts(names);
  const people = (ids: readonly (string | null)[]) =>
    ids.length === 0 ? t("nobody") : ids.map((id) => texts.member(id)).join(", ");
  const undecided = impact.review.filter((item) => item.decision === null && !item.protected);
  return (
    <div
      className="flex flex-col gap-2 rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
      aria-live="polite"
      data-testid={testId}
    >
      <p className="font-medium">{t("impactHeading")}</p>
      {impact.changes.length === 0 ? (
        <p>{t("impactNoChanges")}</p>
      ) : (
        <ul className="ms-5 list-disc" data-testid={`${testId}-changes`}>
          {impact.changes.map((change) => (
            <li key={change.occurrenceId} className="break-words">
              <bdi className="font-medium">{change.title}</bdi>
              {", "}
              {formatTaskDate(change.dueDate, formats)}
              {": "}
              {t(`change_${change.change}`, {
                from: people(change.from),
                to: people(change.to),
                for: texts.member(change.for),
              })}
            </li>
          ))}
        </ul>
      )}
      {undecided.length > 0 ? (
        <p data-testid={`${testId}-review`}>{t("impactReview", { count: undecided.length })}</p>
      ) : null}
      {impact.pauseDates.length > 0 ? (
        <p>{t("impactPaused", { dates: rangesText(impact.pauseDates, formats) })}</p>
      ) : null}
      <p className="text-helper text-fg-muted">
        {t("impactDates", { dates: rangeText(impact.startsOn, impact.endsOn, formats) })}
      </p>
    </div>
  );
}
