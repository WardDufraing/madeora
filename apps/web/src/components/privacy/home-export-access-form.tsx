"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PrivacyActionError, setHomeExportAccess } from "@/privacy/api";

/**
 * The Owner allows or stops one Administrator or Member exporting this Home's data
 * (exportHomeData, S39 part 2). Works at once: stopping it ends their Home exports. The database
 * decides again who may change it, and audits the change.
 */
export function HomeExportAccessForm({
  homeId,
  membershipId,
  memberName,
  granted,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly memberName: string;
  readonly granted: boolean;
}) {
  const t = useTranslations("Privacy");
  const router = useRouter();
  const [chosen, setChosen] = useState(granted);
  const [synced, setSynced] = useState(granted);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"saved" | "failed" | "notPermitted" | null>(null);
  if (synced !== granted) {
    setSynced(granted);
    setChosen(granted);
  }

  async function save() {
    setBusy(true);
    setResult(null);
    try {
      await setHomeExportAccess(homeId, { membershipId, granted: chosen });
      setResult("saved");
      router.refresh();
    } catch (error) {
      if (error instanceof PrivacyActionError && error.failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return;
      }
      setResult(
        error instanceof PrivacyActionError && error.failure === "notPermitted"
          ? "notPermitted"
          : "failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      data-testid="home-export-access-form"
    >
      {result === "saved" ? (
        <FormAlert tone="success" announce>
          {t("homeAccessSaved", { name: memberName })}
        </FormAlert>
      ) : null}
      {result === "failed" || result === "notPermitted" ? (
        <FormAlert tone="error" announce>
          {result === "notPermitted" ? t("homeAccessNotPermitted") : t("actionFailed")}
        </FormAlert>
      ) : null}
      <Checkbox
        label={t("homeAccessLabel", { name: memberName })}
        description={t("homeAccessHint")}
        checked={chosen}
        onChange={(event) => {
          setResult(null);
          setChosen(event.target.checked);
        }}
      />
      <div>
        <Button type="submit" disabled={chosen === granted} loading={busy}>
          {t("homeAccessSave")}
        </Button>
      </div>
    </form>
  );
}
