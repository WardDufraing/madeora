"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PetDetail } from "@/pets/api";
import type { PetCare } from "@/pets/care-shapes";
import { careActivityPath } from "@/pets/format";

import { CareActivityForm } from "./care-activity-form";
import {
  CareStatus,
  CompleteButton,
  useCareNames,
  useOccurrenceWhen,
  useScheduleSummary,
  type CareMember,
} from "./care-parts";
import { usePetTexts } from "./use-pet-texts";

/**
 * A pet's Care section (S31 care part): every care activity with its schedule, its next occurrence,
 * who is responsible and its status, for every member. An activity with medical details shows only
 * its category to someone without medical view. Pet managers add activities. The Home's day-to-day
 * view of care is the separate pet-care widget on the dashboard.
 */
export function PetCareSection({
  pet,
  care,
  members,
}: {
  readonly pet: PetDetail;
  readonly care: PetCare;
  readonly members: readonly CareMember[];
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const names = useCareNames(members);
  const summary = useScheduleSummary();
  const when = useOccurrenceWhen(care.today);
  const [adding, setAdding] = useState(false);

  return (
    <section
      aria-labelledby="pet-care-heading"
      className="flex flex-col gap-4"
      data-testid="pet-care"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="pet-care-heading" className="text-section-title font-semibold text-fg">
          {t("sectionCareSchedule")}
        </h2>
        {care.canManage ? (
          <Button
            onClick={() => {
              setAdding(true);
            }}
            data-testid="care-new"
          >
            {t("careAdd")}
          </Button>
        ) : null}
      </div>
      {care.activities.length === 0 ? (
        <Card>
          <p className="text-body text-fg-muted">{t("careNone")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="care-list">
          {care.activities.map((activity) => {
            const title = texts.careTitle(activity);
            return (
              <li
                key={activity.id}
                className="rounded-card border border-line bg-surface p-4"
                data-testid="care-item"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      href={careActivityPath(pet.homeId, pet.id, activity.id)}
                      className="text-body font-semibold text-accent-fg underline"
                      data-testid="care-link"
                    >
                      {title}
                    </Link>
                    <p className="text-helper text-fg-muted">
                      {texts.careCategory(activity.category)}
                      {activity.schedule ? ` · ${summary(activity.schedule)}` : ""}
                    </p>
                    {activity.state !== "active" ? (
                      <p className="text-helper font-medium text-fg">
                        {activity.state === "paused" ? t("carePaused") : t("careEnded")}
                      </p>
                    ) : activity.next ? (
                      <p className="flex flex-wrap items-center gap-2 text-body text-fg">
                        <span>{t("careNext", { when: when(activity.next) })}</span>
                        <CareStatus status={activity.next.status} />
                        <span className="text-helper text-fg-muted">
                          {names.list(activity.next.members)}
                        </span>
                      </p>
                    ) : (
                      <p className="text-helper text-fg-muted">{t("careNoNext")}</p>
                    )}
                    {activity.overdue > 0 ? (
                      <p className="text-helper text-danger">
                        {t("careOverdueCount", { count: activity.overdue })}
                      </p>
                    ) : null}
                  </div>
                  {activity.state === "active" && activity.next ? (
                    <CompleteButton
                      occurrence={activity.next}
                      label={t("careCompleteLabel", { title, pet: pet.name })}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <CareActivityForm
          homeId={pet.homeId}
          petId={pet.id}
          today={care.today}
          members={members}
          canMarkMedical={care.canManageMedical}
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}
    </section>
  );
}
