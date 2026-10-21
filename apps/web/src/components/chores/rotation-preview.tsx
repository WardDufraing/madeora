"use client";

import { rotationAssignments } from "@madeora/domain/chores";
import type { RecurrenceRule } from "@madeora/domain/tasks";
import { useTranslations } from "next-intl";

import { CHORE_LIMITS } from "@/chores/schema";
import type { DateFormat } from "@/preferences/schema";
import { formatTaskDate } from "@/tasks/format";

export interface RotationPreviewProps {
  readonly rule: RecurrenceRule | null;
  /** Where the order starts counting: the first date created (never before today). */
  readonly rotationFrom: string;
  readonly order: readonly string[];
  readonly nameOf: (memberId: string) => string;
  readonly dateFormat: DateFormat;
}

/**
 * Whose turn the next dates are (S20), from the same rule the database uses, so the person sees
 * the sequence before saving. Text only: no colour carries meaning.
 */
export function RotationPreview({
  rule,
  rotationFrom,
  order,
  nameOf,
  dateFormat,
}: RotationPreviewProps) {
  const t = useTranslations("Chores");
  if (!rule || order.length < 2) return null;
  const next = rotationAssignments(
    rule,
    rotationFrom,
    order.length,
    rotationFrom,
    CHORE_LIMITS.previewDates,
  );
  return (
    <div
      className="rounded-card border border-line bg-surface-sunken p-3 text-body"
      aria-live="polite"
      data-testid="rotation-preview"
    >
      <p className="font-medium text-fg">{t("rotationPreview")}</p>
      {next.length === 0 ? (
        <p className="text-fg-muted">{t("rotationPreviewNone")}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5">
          {next.map((entry) => (
            <li key={entry.date} className="text-fg">
              {t("previewLine", {
                date: formatTaskDate(entry.date, { dateFormat }),
                person: nameOf(order[entry.position] ?? ""),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
