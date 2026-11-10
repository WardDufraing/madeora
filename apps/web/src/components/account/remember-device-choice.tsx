"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { setRememberChoice } from "@/auth/remembered-accounts";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * "Remember this account on this device" on the sign-in page (S38). It covers the email form and
 * Google alike; on a shared or untrusted device, unticking it keeps the account off the chooser.
 */
export function RememberDeviceChoice() {
  const t = useTranslations("Accounts");
  const [remember, setRemember] = useState(true);
  useEffect(() => {
    setRememberChoice(true);
  }, []);
  return (
    <Checkbox
      label={t("rememberLabel")}
      description={t("rememberHint")}
      checked={remember}
      onChange={(event) => {
        setRemember(event.target.checked);
        setRememberChoice(event.target.checked);
      }}
      data-testid="remember-account"
    />
  );
}
