"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import type { DeviceDescription } from "@/auth/sessions";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export interface SessionRow {
  readonly id: string;
  readonly device: DeviceDescription;
  /** Already formatted for the viewer: when it started and (approximately) last used. */
  readonly created: string;
  readonly lastActive: string;
  readonly isCurrent: boolean;
}

export interface SessionsSettingProps {
  readonly sessions: readonly SessionRow[];
}

type Pending =
  | { readonly kind: "report"; readonly session: SessionRow }
  | { readonly kind: "everywhere" }
  | null;

/**
 * Settings › Security › Devices and sessions (S37): the account's own sessions, across all Homes.
 * Signing out one session or reporting it needs no reauthentication, so a suspicious session can
 * be stopped at once; the database only lets an account end its own sessions, and its pre-request
 * check refuses a revoked session's token on the very next request.
 */
export function SessionsSetting({ sessions }: SessionsSettingProps) {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const [rows, setRows] = useState(sessions);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<"revoked" | "gone" | "reported" | null>(null);

  function deviceName(device: DeviceDescription): string {
    return t("deviceName", {
      browser: t(`browser.${device.browser}`),
      platform: t(`platform.${device.platform}`),
    });
  }

  async function revoke(session: SessionRow, report: boolean) {
    setBusy(session.id);
    setFailure(null);
    setNotice(null);
    const { data, error } = await getSupabaseBrowserClient().rpc("revoke_my_session", {
      p_session_id: session.id,
      p_report: report,
    });
    setBusy(null);
    if (error) {
      setFailure(authMessages.failure("unknown"));
      return;
    }
    setRows((current) => current.filter((row) => row.id !== session.id));
    setNotice(report ? "reported" : data ? "revoked" : "gone");
  }

  async function signOutEverywhere() {
    setBusy("everywhere");
    setFailure(null);
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.rpc("sign_out_everywhere");
    if (error) {
      setBusy(null);
      setFailure(authMessages.failure("unknown"));
      return;
    }
    // The server has already ended this session too; this clears the browser's own cookies.
    await supabase.auth.signOut({ scope: "local" });
    window.location.assign(new URL("/sign-in?status=signed-out", window.location.origin));
  }

  return (
    <div className="flex flex-col gap-4" data-testid="sessions-setting">
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      {notice === "reported" ? (
        <FormAlert tone="success" announce>
          <span className="flex flex-col gap-2">
            <span>{t("reportedNotice")}</span>
            <span>{t("reportedNextSteps")}</span>
          </span>
        </FormAlert>
      ) : notice ? (
        <FormAlert tone="success" announce>
          {notice === "revoked" ? t("revokedNotice") : t("alreadyGoneNotice")}
        </FormAlert>
      ) : null}

      <ul className="flex flex-col divide-y divide-line" aria-label={t("sessionsTitle")}>
        {rows.map((session) => (
          <li key={session.id} className="flex flex-col gap-2 py-3" data-testid="session-row">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-body font-semibold">{deviceName(session.device)}</span>
              <span className="text-helper text-fg-muted">{t(`kind.${session.device.kind}`)}</span>
              {session.isCurrent ? (
                <span className="rounded-full border border-line px-2 text-helper font-medium">
                  {t("thisDevice")}
                </span>
              ) : null}
            </div>
            <p className="text-helper text-fg-muted">
              {t("sessionTimes", { created: session.created, lastActive: session.lastActive })}
            </p>
            {session.isCurrent ? null : (
              <div className="flex flex-wrap gap-3">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === session.id}
                  aria-label={t("signOutSessionLabel", { device: deviceName(session.device) })}
                  onClick={() => void revoke(session, false)}
                >
                  {t("signOutSession")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("reportSessionLabel", { device: deviceName(session.device) })}
                  onClick={() => {
                    setPending({ kind: "report", session });
                  }}
                >
                  {t("reportSession")}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div>
        <Button
          variant="destructive"
          onClick={() => {
            setPending({ kind: "everywhere" });
          }}
        >
          {t("signOutEverywhere")}
        </Button>
      </div>

      <Dialog
        open={pending?.kind === "everywhere"}
        onClose={() => {
          setPending(null);
        }}
        title={t("signOutEverywhereTitle")}
        description={t("signOutEverywhereExplanation")}
        closeLabel={t("cancel")}
        footer={
          <Button
            variant="destructive"
            loading={busy === "everywhere"}
            onClick={() => void signOutEverywhere()}
          >
            {t("signOutEverywhereConfirm")}
          </Button>
        }
      />
      <Dialog
        open={pending?.kind === "report"}
        onClose={() => {
          setPending(null);
        }}
        title={t("reportTitle")}
        description={t("reportExplanation")}
        closeLabel={t("cancel")}
        footer={
          pending?.kind === "report" ? (
            <Button
              variant="destructive"
              loading={busy === pending.session.id}
              onClick={() => {
                const session = pending.session;
                setPending(null);
                void revoke(session, true);
              }}
            >
              {t("reportConfirm")}
            </Button>
          ) : null
        }
      />
    </div>
  );
}
