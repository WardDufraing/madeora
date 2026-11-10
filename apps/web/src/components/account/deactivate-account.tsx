"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { ActivityActionError, deactivateAccount } from "@/activity/api";
import type { AccountChangeAction } from "@/auth/google-reauth";
import { reauthenticate } from "@/auth/reauthenticate";
import { reauthenticationSchema, type ReauthenticationValues } from "@/auth/schemas";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import {
  ConfirmWithGoogle,
  ReauthFields,
  reauthModeFor,
  useReauthMessages,
} from "@/components/security/reauth-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export interface DeactivationBlocker {
  readonly homeId: string;
  readonly homeName: string;
}

export interface DeactivateAccountProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
  readonly blockers: readonly DeactivationBlocker[];
}

/**
 * Temporary account deactivation (S38, spec "Confirmed temporary adult account deactivation"):
 * an explicit confirmation, then a fresh "confirm it's you" (password and code, or Google). Every
 * Home the person alone owns must get another Owner first. Afterwards every session has ended and
 * this browser goes to the sign-in page with a full page load, so nothing of the account stays in
 * memory.
 */
export function DeactivateAccount({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  blockers,
}: DeactivateAccountProps) {
  const t = useTranslations("Lifecycle");
  const router = useRouter();
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, "deactivate_account");
  const [understood, setUnderstood] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const resolver = useMemo(
    () => zodResolver(reauthenticationSchema(twoFactor, mode === "password")),
    [twoFactor, mode],
  );
  const form = useForm<ReauthenticationValues>({
    resolver,
    defaultValues: { password: "", code: "" },
  });

  /** Returns false when a fresh confirmation is needed first. */
  async function perform(): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      await deactivateAccount();
      window.location.assign(new URL("/sign-in?status=deactivated", window.location.origin));
      return true;
    } catch (error) {
      const failure = error instanceof ActivityActionError ? error.failure : "failed";
      if (failure === "reauthenticate") return false;
      if (failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return true;
      }
      if (failure === "soleOwner") {
        setMessage(t("deactivateSoleOwner"));
        router.refresh();
      } else {
        setMessage(t("deactivateFailed"));
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!understood) {
      setMessage(t("deactivateConfirmRequired"));
      return;
    }
    if (!(await perform())) setAsking(true);
  }

  const onConfirm = form.handleSubmit(async (values) => {
    if (mode !== "password" || !captcha.ready) return;
    setMessage(null);
    const failed = await reauthenticate(
      {
        email,
        password: values.password,
        code: twoFactor ? values.code : null,
        captchaOptions: captcha.options,
      },
      (client, sessionId) =>
        client.rpc("authorize_account_change", {
          p_action: "deactivate_account",
          p_session_id: sessionId,
        }),
    );
    captcha.reset();
    form.reset({ password: "", code: "" });
    if (failed) {
      setMessage(reauthMessage(failed));
      return;
    }
    setAsking(false);
    if (!(await perform())) setMessage(t("deactivateFailed"));
  });

  if (blockers.length > 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="deactivation-blocked">
        <FormAlert tone="info">{t("blockedIntro")}</FormAlert>
        <ul className="flex flex-col gap-2">
          {blockers.map((blocker) => (
            <li key={blocker.homeId} className="text-body">
              <bdi className="font-semibold">{blocker.homeName}</bdi>{" "}
              <Link
                href={`/homes/${blocker.homeId}/members`}
                className="font-medium text-accent-fg underline"
              >
                {t("blockedTransferLink")}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="deactivate-account">
      {message ? (
        <FormAlert tone="error" announce>
          {message}
        </FormAlert>
      ) : null}
      {asking ? (
        mode === "google" ? (
          <div className="flex flex-col gap-3 rounded-control border border-line p-4">
            <p className="text-body">{t("deactivateConfirmIntro")}</p>
            <ConfirmWithGoogle
              action="deactivate_account"
              email={email}
              userId={userId}
              twoFactor={twoFactor}
              label={t("deactivate")}
            />
            <div>
              <Button
                variant="ghost"
                onClick={() => {
                  setAsking(false);
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            method="post"
            noValidate
            aria-label={t("deactivateConfirmIntro")}
            onSubmit={(event) => {
              void onConfirm(event);
            }}
            className="flex flex-col gap-4 rounded-control border border-line p-4"
          >
            <p className="text-body">{t("deactivateConfirmIntro")}</p>
            <ReauthFields
              password={form.register("password")}
              code={form.register("code")}
              passwordError={form.formState.errors.password?.message}
              codeError={form.formState.errors.code?.message}
              withCode={twoFactor}
            />
            {captcha.check}
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                variant="destructive"
                loading={form.formState.isSubmitting || busy || !captcha.ready}
              >
                {t("deactivate")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setAsking(false);
                  form.reset({ password: "", code: "" });
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        )
      ) : (
        <>
          <Checkbox
            label={t("deactivateUnderstand")}
            checked={understood}
            onChange={(event) => {
              setUnderstood(event.target.checked);
            }}
            data-testid="deactivate-understand"
          />
          <div>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => {
                void start();
              }}
            >
              {t("deactivate")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
