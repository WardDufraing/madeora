"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { saveHomeDisplaySettings } from "@/displays/api";
import { AMBIENT_AFTER_CHOICES, isAmbientAfter, type AmbientAfterSeconds } from "@/displays/schema";
import { MemberActionError, type MemberFailure } from "@/members/manage-api";

/**
 * The Home's ambient settings (decision 36): how long its displays wait without a touch before the
 * ambient view (UX8a), and which privacy-safe counts that view may show next to the time and date
 * (UX8b; both off by default, counts only). For the Home's managers; the server checks again.
 */
export function DisplayAmbientSetting({
  homeId,
  ambientAfterSeconds,
  ambientShowChores,
  ambientShowShopping,
}: {
  readonly homeId: string;
  readonly ambientAfterSeconds: AmbientAfterSeconds;
  readonly ambientShowChores: boolean;
  readonly ambientShowShopping: boolean;
}) {
  const t = useTranslations("Displays");
  const router = useRouter();
  const hydrated = useHydrated();
  const [value, setValue] = useState<AmbientAfterSeconds>(ambientAfterSeconds);
  const [showChores, setShowChores] = useState(ambientShowChores);
  const [showShopping, setShowShopping] = useState(ambientShowShopping);
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
        saveHomeDisplaySettings(homeId, {
          ambientAfterSeconds: value,
          ambientShowChores: showChores,
          ambientShowShopping: showShopping,
        })
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
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-body font-medium text-fg">{t("ambientCountsLabel")}</legend>
        <p className="text-helper text-fg-muted">{t("ambientCountsIntro")}</p>
        <Checkbox
          label={t("ambientShowChores")}
          checked={showChores}
          onChange={(event) => {
            setShowChores(event.target.checked);
            setSaved(false);
          }}
        />
        <Checkbox
          label={t("ambientShowShopping")}
          checked={showShopping}
          onChange={(event) => {
            setShowShopping(event.target.checked);
            setSaved(false);
          }}
        />
      </fieldset>
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
