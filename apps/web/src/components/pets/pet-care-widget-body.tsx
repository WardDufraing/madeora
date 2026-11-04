"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

import type { HomeCare } from "@/pets/care-shapes";
import { careActivityPath, petPath, petsPath } from "@/pets/format";

import {
  CareStatus,
  CompleteButton,
  useCareNames,
  useOccurrenceWhen,
  type CareMember,
} from "./care-parts";
import { usePetTexts } from "./use-pet-texts";

/**
 * The Pet care widget's rows: per occurrence the pet, the care (its category only when concealed),
 * when, its status and who is responsible, with Done for any member. Overdue care comes first.
 */
export function PetCareWidgetBody({
  homeId,
  care,
  members,
  days,
}: {
  readonly homeId: string;
  readonly care: HomeCare;
  readonly members: readonly CareMember[];
  readonly days: 1 | 3 | 7;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const names = useCareNames(members);
  const when = useOccurrenceWhen(care.today);
  if (care.rows.length === 0) {
    return (
      <p className="text-body text-fg-muted" data-testid="pet-care-widget-empty">
        {t("widgetCareNone", { days })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="pet-care-widget">
      <ul className="flex flex-col gap-2">
        {care.rows.map((row) => {
          const title = texts.careTitle(row.activity);
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-card border border-line bg-surface p-3"
              data-testid="pet-care-widget-row"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-body text-fg">
                  <Link
                    href={careActivityPath(homeId, row.petId, row.activityId)}
                    className="font-semibold text-accent-fg underline"
                  >
                    {title}
                  </Link>
                  {" · "}
                  <Link href={petPath(homeId, row.petId)} className="text-accent-fg underline">
                    {row.petName}
                  </Link>
                </p>
                <p className="flex flex-wrap items-center gap-2 text-helper text-fg-muted">
                  <span>{when(row)}</span>
                  <CareStatus status={row.status} />
                  <span>{names.list(row.members)}</span>
                </p>
              </div>
              <CompleteButton
                occurrence={row}
                label={t("careCompleteLabel", { title, pet: row.petName })}
              />
            </li>
          );
        })}
      </ul>
      {care.hasMore ? (
        <Link href={petsPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("widgetCareMore")}
        </Link>
      ) : null}
    </div>
  );
}
