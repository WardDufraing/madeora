"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_SUMMARY_SETTINGS_ENDPOINT,
  sendChoreRequest,
  type ManagerSummarySetting,
} from "@/chores/api";
import { noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

const hours = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * A chore manager's own daily summary for this Home (S21): off by default, or once a day at an
 * hour in their own timezone. It arrives as a Chores notification, in the app and by email as their
 * notification settings say.
 */
export function ChoreSummarySetting({
  homeId,
  setting,
  timeZone,
}: {
  readonly homeId: string;
  readonly setting: ManagerSummarySetting;
  /** The person's timezone, which the hour is in. */
  readonly timeZone: string;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  const [enabled, setEnabled] = useState(setting.enabled);
  const [hour, setHour] = useState(String(setting.hour));
  const save = useChoreMutation(
    `chore-summary-setting:${homeId}`,
    () =>
      sendChoreRequest("PUT", CHORE_SUMMARY_SETTINGS_ENDPOINT, {
        homeId,
        enabled,
        hour: Number(hour),
        expectedRevision: setting.revision,
      }),
    () => {
      announce(t("announceSummarySaved"));
    },
  );
  const changed = enabled !== setting.enabled || Number(hour) !== setting.hour;

  return (
    <form
      noValidate
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      aria-labelledby="chore-summary-setting-heading"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(undefined);
      }}
      data-testid="chore-summary-setting"
    >
      {region}
      <h2 id="chore-summary-setting-heading" className="text-section-title font-semibold text-fg">
        {t("summarySettingHeading")}
      </h2>
      <Checkbox
        label={t("summarySettingEnabled")}
        description={t("summarySettingHelp")}
        checked={enabled}
        onChange={(event) => {
          setEnabled(event.target.checked);
        }}
        data-testid="chore-summary-enabled"
      />
      <SelectField
        label={t("summarySettingHour")}
        description={t("summarySettingZone", { zone: timeZone })}
        value={hour}
        disabled={!enabled}
        options={hours.map((value) => ({
          value: String(value),
          label: `${String(value).padStart(2, "0")}:00`,
        }))}
        onChange={(event) => {
          setHour(event.target.value);
        }}
        className="max-w-48"
        data-testid="chore-summary-hour"
      />
      {save.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(save.error.failure, save.error.detail)}
        </FormAlert>
      ) : null}
      <div>
        <Button
          type="submit"
          loading={save.busy}
          disabled={!changed}
          data-testid="chore-summary-save"
        >
          {t("summarySettingSave")}
        </Button>
      </div>
    </form>
  );
}
