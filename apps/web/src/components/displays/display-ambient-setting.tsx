"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { saveHomeDisplaySettings } from "@/displays/api";
import { AMBIENT_AFTER_CHOICES, isAmbientAfter, type AmbientAfterSeconds } from "@/displays/schema";
import { MemberActionError, type MemberFailure } from "@/members/manage-api";

/**
 * The Home's ambient timing (UX8a, decision 36): how long its displays wait without a touch before
 * showing only the time and date. For the Home's managers; the server checks again.
 */
export function DisplayAmbientSetting({
  homeId,
  ambientAfterSeconds,
}: {
  readonly homeId: string;
  readonly ambientAfterSeconds: AmbientAfterSeconds;
}) {
  const t = useTranslations("Displays");
  const router = useRouter();
  const hydrated = useHydrated();
  const [value, setValue] = useState<AmbientAfterSeconds>(ambientAfterSeconds);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<MemberFailure | null>(null);

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-4"
      data-testid="display-ambient-setting"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setSaved(false);
        setFailure(null);
        saveHomeDisplaySettings(homeId, { ambientAfterSeconds: value })
          .then(() => {
            setSaved(true);
            router.refresh();
          })
          .catch((error: unknown) => {
            setFailure(error instanceof MemberActionError ? error.failure : "failed");
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <SelectField
        label={t("ambientLabel")}
        description={t("ambientIntro")}
        value={String(value)}
        options={AMBIENT_AFTER_CHOICES.map((seconds) => ({
          value: String(seconds),
          label: t("ambientOption", { minutes: seconds / 60 }),
        }))}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (isAmbientAfter(next)) setValue(next);
          setSaved(false);
        }}
      />
      {saved ? (
        <FormAlert tone="success" announce>
          {t("ambientSaved")}
        </FormAlert>
      ) : null}
      <MemberFailureAlert failure={failure} />
      <div>
        <Button type="submit" disabled={!hydrated} loading={pending}>
          {t("ambientSave")}
        </Button>
      </div>
    </form>
  );
}
