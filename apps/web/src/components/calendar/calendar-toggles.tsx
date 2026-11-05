"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { CALENDAR_PREFERENCES_ENDPOINT, sendCalendarRequest } from "@/calendar/api";
import type { CalendarPreferences } from "@/calendar/schema";
import { Checkbox } from "@/components/ui/checkbox";

import { CalendarFailureAlert } from "./calendar-failure";
import { useCalendarMutation } from "./use-calendar-mutation";

type Setting = "showTasks" | "showChores" | "showVacations";

/**
 * The calendar's own view settings (S32; PS L1708, L1907, L2128): Show tasks (any calendar), Show
 * chores and Show Home vacations (a Home's), each the person's own choice for this calendar and
 * remembered for them. Turning one off hides only the overlay: no task, chore or vacation changes.
 */
export function CalendarToggles({
  homeId,
  showTasks,
  showChores,
  showVacations,
}: {
  readonly homeId: string | null;
  readonly showTasks: boolean;
  readonly showChores: boolean;
  readonly showVacations: boolean;
}) {
  const t = useTranslations("Calendar");
  const save = useCalendarMutation(
    `calendar-preferences:${homeId ?? "personal"}`,
    (change: { readonly setting: Setting; readonly value: boolean }) => {
      const body: CalendarPreferences = { homeId, [change.setting]: change.value };
      return sendCalendarRequest("PUT", CALENDAR_PREFERENCES_ENDPOINT, body);
    },
  );
  // The person's choice shows at once and stays until the page brings a new saved value (or the save
  // fails), so the box never flickers back while the page refreshes.
  const [chosen, setChosen] = useState<
    Partial<Record<Setting, { readonly value: boolean; readonly saved: boolean }>>
  >({});
  const shown = (setting: Setting, saved: boolean) => {
    const choice = chosen[setting];
    return choice && choice.saved === saved ? choice.value : saved;
  };
  const toggle = (setting: Setting, label: string, saved: boolean, testId: string) => (
    <Checkbox
      label={label}
      checked={shown(setting, saved)}
      onChange={(event) => {
        const value = event.target.checked;
        setChosen((current) => ({ ...current, [setting]: { value, saved } }));
        save.mutate(
          { setting, value },
          {
            onError: () => {
              setChosen((current) => ({ ...current, [setting]: undefined }));
            },
          },
        );
      }}
      data-testid={testId}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
        <legend className="sr-only">{t("overlaysLegend")}</legend>
        {toggle("showTasks", t("showTasks"), showTasks, "calendar-show-tasks")}
        {homeId ? toggle("showChores", t("showChores"), showChores, "calendar-show-chores") : null}
        {homeId
          ? toggle("showVacations", t("showVacations"), showVacations, "calendar-show-vacations")
          : null}
      </fieldset>
      <CalendarFailureAlert error={save.error} />
    </div>
  );
}
