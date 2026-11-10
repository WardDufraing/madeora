"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { ActivityActionError, setSecurityAlerts } from "@/activity/api";
import { securityAlertsSchema, type SecurityAlertsInput } from "@/activity/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export interface SecurityAlertsSettingProps {
  readonly newDevice: boolean;
  readonly everySignIn: boolean;
}

/**
 * Account › Security › Notifications, the optional part (S38, spec: routine new-device and
 * successful sign-in alerts per category, account-wide). Mandatory alerts are listed beside it
 * and are not choices.
 */
export function SecurityAlertsSetting({ newDevice, everySignIn }: SecurityAlertsSettingProps) {
  const t = useTranslations("Activity");
  const [status, setStatus] = useState<"saved" | "failed" | null>(null);
  const form = useForm<SecurityAlertsInput>({
    resolver: zodResolver(securityAlertsSchema),
    defaultValues: { newDevice, everySignIn },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setStatus(null);
    try {
      await setSecurityAlerts(values);
      form.reset(values);
      setStatus("saved");
    } catch (error) {
      if (error instanceof ActivityActionError && error.failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return;
      }
      setStatus("failed");
    }
  });

  return (
    <form
      method="post"
      noValidate
      aria-label={t("routineTitle")}
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
      data-testid="security-alerts-form"
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-body font-semibold">{t("routineTitle")}</legend>
        <Checkbox
          label={t("newDeviceLabel")}
          description={t("newDeviceHint")}
          {...form.register("newDevice")}
        />
        <Checkbox
          label={t("everySignInLabel")}
          description={t("everySignInHint")}
          {...form.register("everySignIn")}
        />
      </fieldset>
      {status === "saved" ? (
        <FormAlert tone="success" announce>
          {t("alertsSaved")}
        </FormAlert>
      ) : null}
      {status === "failed" ? (
        <FormAlert tone="error" announce>
          {t("alertsSaveFailed")}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" loading={form.formState.isSubmitting}>
          {t("alertsSave")}
        </Button>
      </div>
    </form>
  );
}
