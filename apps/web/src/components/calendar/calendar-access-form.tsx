"use client";

import { calendarMemberLevels, type CalendarMemberLevel } from "@madeora/domain/permissions";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { calendarAccessEndpoint, sendCalendarRequest } from "@/calendar/api";
import { calendarAccessSchema } from "@/calendar/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";

import { CalendarFailureAlert } from "./calendar-failure";
import { useCalendarMutation } from "./use-calendar-mutation";

/**
 * Sets one member's access to the Home calendar (S32; PS L78): View, Edit (the default) or Edit and
 * delete. Editing and deleting are separate, and creating an event gives its creator nothing extra.
 * It works on the member's next request and is audited; the database decides again who may change
 * it (calendar managers, never their own level or another manager's).
 */
export function CalendarAccessForm({
  homeId,
  membershipId,
  memberName,
  level,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly memberName: string;
  readonly level: CalendarMemberLevel;
}) {
  const t = useTranslations("Calendar");
  const [chosen, setChosen] = useState<CalendarMemberLevel>(level);
  const [saved, setSaved] = useState(false);
  const [synced, setSynced] = useState(level);
  if (synced !== level) {
    setSynced(level);
    setChosen(level);
  }
  const save = useCalendarMutation(
    `calendar-access:${membershipId}`,
    (body: object) => sendCalendarRequest("PUT", calendarAccessEndpoint(homeId), body),
    () => {
      setSaved(true);
    },
  );
  const label = {
    view: t("accessView"),
    edit: t("accessEdit"),
    edit_delete: t("accessEditDelete"),
  } as const satisfies Record<CalendarMemberLevel, string>;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        const parsed = calendarAccessSchema.safeParse({ membershipId, level: chosen });
        if (parsed.success) save.mutate(parsed.data);
      }}
      data-testid="calendar-access-form"
    >
      {saved ? (
        <FormAlert tone="success" announce>
          {t("accessSaved", { name: memberName })}
        </FormAlert>
      ) : null}
      <CalendarFailureAlert error={save.error} />
      <SelectField
        label={t("accessLabel", { name: memberName })}
        options={calendarMemberLevels.map((value) => ({ value, label: label[value] }))}
        value={chosen}
        onChange={(event) => {
          setSaved(false);
          setChosen(calendarMemberLevels.find((value) => value === event.target.value) ?? "edit");
        }}
        data-testid="calendar-access-level"
      />
      <div>
        <Button
          type="submit"
          disabled={chosen === level}
          loading={save.busy}
          data-testid="calendar-access-save"
        >
          {t("accessSave")}
        </Button>
      </div>
    </form>
  );
}
