"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { careOccurrenceEndpoint, sendPetRequest } from "@/pets/api";
import type { PetCareStatus } from "@/pets/care-schema";
import type { CareOccurrence, CareSchedule } from "@/pets/care-shapes";

import { PetFailureAlert } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

/** A member of the Home as the care views name them: by membership id. */
export interface CareMember {
  readonly id: string;
  readonly name: string | null;
  readonly isSelf: boolean;
}

/** Names people by membership id: "You", their name, "A member without a name", or "A former member". */
export function useCareNames(members: readonly CareMember[]) {
  const t = useTranslations("Pets");
  const byId = new Map(members.map((member) => [member.id, member]));
  const one = (id: string | null) => {
    const member = id === null ? undefined : byId.get(id);
    if (!member) return t("memberFormer");
    if (member.isSelf) return t("memberYou");
    return member.name ?? t("memberUnnamed");
  };
  return {
    one,
    /** Responsible members, or "Unassigned". */
    list: (ids: readonly (string | null)[]) =>
      ids.length === 0 ? t("careUnassigned") : ids.map(one).join(", "),
  };
}

const statusTone: { readonly [S in PetCareStatus]: string } = {
  upcoming: "bg-surface-sunken text-fg-muted",
  due: "bg-accent-subtle text-accent-fg",
  overdue: "bg-danger-subtle text-danger",
  completed: "bg-success-subtle text-success",
  skipped: "bg-surface-sunken text-fg-muted",
  paused: "bg-surface-sunken text-fg-muted",
};

/** An occurrence's status, as text (never colour alone). */
export function CareStatus({ status }: { readonly status: PetCareStatus }) {
  const texts = usePetTexts();
  return (
    <span
      className={cx("rounded-full px-2 py-0.5 text-helper font-medium", statusTone[status])}
      data-testid="care-status"
    >
      {texts.careStatus(status)}
    </span>
  );
}

/** "Every 2 weeks on Monday, Thursday from 4 Nov 2026 at 07:30", in the viewer's language. */
export function useScheduleSummary() {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const weekday = (day: number) =>
    new Intl.DateTimeFormat(texts.locale, { weekday: "long", timeZone: "UTC" }).format(
      // 2024-01-01 was a Monday (ISO weekday 1).
      new Date(Date.UTC(2024, 0, day)),
    );
  return (schedule: CareSchedule): string => {
    const when =
      schedule.frequency === "once"
        ? t("scheduleOnce", { date: texts.shortDate(schedule.startsOn) })
        : t("scheduleRepeat", {
            frequency: schedule.frequency,
            interval: schedule.interval,
            days: (schedule.weekdays ?? []).map(weekday).join(", "),
            start: texts.shortDate(schedule.startsOn),
          });
    const end = schedule.endsOn
      ? t("scheduleUntil", { date: texts.shortDate(schedule.endsOn) })
      : "";
    const time = schedule.time ? t("scheduleAt", { time: schedule.time }) : t("scheduleAnyTime");
    return [when, end, time].filter((part) => part !== "").join(" · ");
  };
}

/** "Today", "Tomorrow" or the date, with the time when there is one. */
export function useOccurrenceWhen(today: string) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  return (occurrence: { readonly dueOn: string; readonly time: string | null }) => {
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const day =
      occurrence.dueOn === today
        ? t("today")
        : occurrence.dueOn === tomorrow.toISOString().slice(0, 10)
          ? t("tomorrow")
          : texts.shortDate(occurrence.dueOn);
    return occurrence.time ? t("dayAtTime", { day, time: occurrence.time }) : day;
  };
}

/**
 * Records that the care was given now (any member). Someone else's completion in the meantime is
 * reported, and the page refreshes.
 */
export function CompleteButton({
  occurrence,
  label,
}: {
  readonly occurrence: Pick<CareOccurrence, "id" | "revision">;
  /** The accessible name, naming the care ("Mark Breakfast for Rex done"). */
  readonly label: string;
}) {
  const t = useTranslations("Pets");
  const complete = usePetMutation(`pet-care-occurrence:${occurrence.id}`, (revision: number) =>
    sendPetRequest("POST", careOccurrenceEndpoint(occurrence.id), {
      action: "complete",
      revision,
    }),
  );
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        aria-label={label}
        loading={complete.busy}
        onClick={() => {
          complete.mutate(occurrence.revision);
        }}
        data-testid="care-complete"
      >
        {t("careComplete")}
      </Button>
      <PetFailureAlert error={complete.error} />
    </div>
  );
}
