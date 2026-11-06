"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import type { DeviceDescription } from "@/auth/sessions";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";

export interface TrustedDeviceRow {
  readonly id: string;
  readonly device: DeviceDescription;
  /** Already formatted for the viewer. */
  readonly trusted: string;
  readonly expires: string;
  readonly isCurrent: boolean;
}

export interface TrustedDevicesSettingProps {
  readonly devices: readonly TrustedDeviceRow[];
}

/**
 * Settings › Security › Trusted browsers (S37): browsers that skip the authenticator code for 30
 * days. Ending trust only takes something away, so it needs no reauthentication. A password,
 * email or two-factor change, a reported session and "sign out everywhere" end all trust at once.
 */
export function TrustedDevicesSetting({ devices }: TrustedDevicesSettingProps) {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const [rows, setRows] = useState(devices);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);

  function deviceName(device: DeviceDescription): string {
    return t("deviceName", {
      browser: t(`browser.${device.browser}`),
      platform: t(`platform.${device.platform}`),
    });
  }

  /** Ends one browser's trust, or every browser's with null. */
  async function revoke(id: string | null) {
    setBusy(id ?? "all");
    setFailure(null);
    setNotice(false);
    const supabase = getSupabaseBrowserClient();
    const { error } =
      id === null
        ? await supabase.rpc("revoke_all_trusted_devices")
        : await supabase.rpc("revoke_trusted_device", { p_device_id: id });
    setBusy(null);
    if (error) {
      setFailure(authMessages.failure("unknown"));
      return;
    }
    setRows((current) => (id === null ? [] : current.filter((row) => row.id !== id)));
    setNotice(true);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="trusted-devices-setting">
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      {notice ? (
        <FormAlert tone="success" announce>
          {t("trustRevokedNotice")}
        </FormAlert>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-body text-fg-muted">{t("trustedNone")}</p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-line" aria-label={t("trustedTitle")}>
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 py-3" data-testid="trusted-row">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-body font-semibold">{deviceName(row.device)}</span>
                  {row.isCurrent ? (
                    <span className="rounded-full border border-line px-2 text-helper font-medium">
                      {t("thisDevice")}
                    </span>
                  ) : null}
                </div>
                <p className="text-helper text-fg-muted">
                  {t("trustedTimes", { trusted: row.trusted, expires: row.expires })}
                </p>
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === row.id}
                    aria-label={t("revokeTrustLabel", { device: deviceName(row.device) })}
                    onClick={() => void revoke(row.id)}
                  >
                    {t("revokeTrust")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <Button variant="ghost" loading={busy === "all"} onClick={() => void revoke(null)}>
              {t("revokeAllTrust")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
