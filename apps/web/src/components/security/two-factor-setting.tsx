"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import type { AccountChangeAction } from "@/auth/google-reauth";
import { reauthenticate, type ReauthenticationError } from "@/auth/reauthenticate";
import {
  reauthenticationSchema,
  totpCodeSchema,
  type ReauthenticationValues,
  type TotpCodeValues,
} from "@/auth/schemas";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { classifyTwoFactorError, type TwoFactorFailure } from "@/auth/two-factor";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

import {
  ConfirmWithGoogle,
  ReauthFields,
  reauthModeFor,
  useReauthMessages,
  useTwoFactorMessages,
} from "./reauth-fields";
import { RecoveryCodes } from "./recovery-codes";

export interface TwoFactorSettingProps {
  readonly email: string;
  readonly userId: string;
  readonly enabled: boolean;
  /** The verified authenticator's id, when two-factor sign-in is on. */
  readonly factorId: string | null;
  readonly recoveryCodesLeft: number;
  /** Without a password (Google-only accounts), Google confirms it's you instead. */
  readonly hasPassword: boolean;
  /** The change Google has just confirmed for this page, if any. */
  readonly confirmed: AccountChangeAction | null;
}

type Action = "enroll" | "disable" | "regenerate";

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "reauth"; readonly action: Action }
  | {
      readonly kind: "scan";
      readonly factorId: string;
      readonly qr: string;
      readonly secret: string;
    }
  | { readonly kind: "codes"; readonly codes: readonly string[] };

/** The database's one-time permission for each action (supabase/migrations/…_adult_security.sql). */
const permission = {
  enroll: "two_factor_enroll",
  disable: "two_factor_disable",
  regenerate: "recovery_codes",
} as const satisfies Record<Action, AccountChangeAction>;

function confirmedAction(confirmed: AccountChangeAction | null): Action | null {
  const actions = Object.keys(permission) as Action[];
  return actions.find((action) => permission[action] === confirmed) ?? null;
}

/**
 * Settings › Security › Two-factor sign-in (S37): optional for every adult. Turning it on, off and
 * replacing the recovery codes each need a fresh reauthentication; the authenticator's secret is
 * shown only while it is being set up, the recovery codes only once.
 */
export function TwoFactorSetting({
  email,
  userId,
  enabled,
  factorId,
  recoveryCodesLeft,
  hasPassword,
  confirmed,
}: TwoFactorSettingProps) {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const reauthMessage = useReauthMessages();
  const codeMessage = useTwoFactorMessages();
  const captcha = useCaptcha("reauthenticate");
  const [stage, setStage] = useState<Stage>(() => {
    const action = hasPassword ? null : confirmedAction(confirmed);
    return action ? { kind: "reauth", action } : { kind: "idle" };
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reauthResolver = useMemo(
    () => zodResolver(reauthenticationSchema(enabled, hasPassword)),
    [enabled, hasPassword],
  );
  const reauthForm = useForm<ReauthenticationValues>({
    resolver: reauthResolver,
    defaultValues: { password: "", code: "" },
  });
  const codeForm = useForm<TotpCodeValues>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: "" },
  });

  function start(action: Action) {
    setStage({ kind: "reauth", action });
    setFailure(null);
    reauthForm.reset({ password: "", code: "" });
  }

  function cancel() {
    setStage({ kind: "idle" });
    setFailure(null);
  }

  function finish(query: string) {
    window.location.assign(new URL(`/settings/security?${query}`, window.location.origin));
  }

  async function createCodes(): Promise<void> {
    const { data, error } = await getSupabaseBrowserClient().rpc(
      "create_two_factor_recovery_codes",
    );
    if (error) {
      setFailure(authMessages.failure("unknown"));
      return;
    }
    setStage({ kind: "codes", codes: data });
  }

  const onReauth = reauthForm.handleSubmit(async (values) => {
    if (stage.kind !== "reauth") return;
    const action = stage.action;
    const mode = reauthModeFor(hasPassword, confirmed, permission[action]);
    if (mode === "google") return;
    setFailure(null);
    if (mode === "password") {
      if (!captcha.ready) return;
      const failed: ReauthenticationError | null = await reauthenticate(
        {
          email,
          password: values.password,
          code: enabled ? values.code : null,
          captchaOptions: captcha.options,
        },
        (client, sessionId) =>
          client.rpc("authorize_account_change", {
            p_action: permission[action],
            p_session_id: sessionId,
          }),
      );
      captcha.reset();
      reauthForm.reset({ password: "", code: "" });
      if (failed) {
        setFailure(reauthMessage(failed));
        return;
      }
    }

    setBusy(true);
    try {
      const supabase = getSupabaseBrowserClient();
      if (action === "enroll") {
        // An earlier setup that was never finished is removed first (always allowed).
        const { data: listed } = await supabase.auth.mfa.listFactors();
        for (const factor of listed?.all ?? []) {
          if (factor.factor_type === "totp" && factor.status === "unverified") {
            await supabase.auth.mfa.unenroll({ factorId: factor.id });
          }
        }
        const { data, error } = await supabase.auth.mfa.enroll({
          factorType: "totp",
          issuer: "Madeora",
        });
        if (error) {
          setFailure(authMessages.failure("unknown"));
          return;
        }
        codeForm.reset({ code: "" });
        setStage({
          kind: "scan",
          factorId: data.id,
          qr: data.totp.qr_code,
          secret: data.totp.secret,
        });
        return;
      }
      if (action === "disable") {
        if (factorId === null) return;
        const { error } = await supabase.auth.mfa.unenroll({ factorId });
        if (error) {
          setFailure(t("notAllowed"));
          return;
        }
        // The session's assurance level changes with the factor; take the new token.
        await supabase.auth.refreshSession();
        finish("twoFactor=off");
        return;
      }
      await createCodes();
    } finally {
      setBusy(false);
    }
  });

  const onVerify = codeForm.handleSubmit(async (values) => {
    if (stage.kind !== "scan") return;
    setFailure(null);
    const { error } = await getSupabaseBrowserClient().auth.mfa.challengeAndVerify({
      factorId: stage.factorId,
      code: totpCodeSchema.parse(values).code,
    });
    if (error) {
      const kind: TwoFactorFailure = classifyTwoFactorError(error);
      setFailure(codeMessage(kind));
      codeForm.setValue("code", "");
      return;
    }
    await createCodes();
  });

  const stageMode =
    stage.kind === "reauth"
      ? reauthModeFor(hasPassword, confirmed, permission[stage.action])
      : null;

  if (stage.kind === "codes") {
    return (
      <RecoveryCodes
        codes={stage.codes}
        onDone={() => {
          finish(enabled ? "codes=new" : "twoFactor=on");
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="two-factor-setting">
      <p className="text-body">{enabled ? t("twoFactorOn") : t("twoFactorOff")}</p>
      {enabled ? (
        <p className="text-helper text-fg-muted">
          {t("recoveryCodesLeft", { count: recoveryCodesLeft })}
        </p>
      ) : (
        <p className="text-helper text-fg-muted">{t("twoFactorWhy")}</p>
      )}

      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}

      {stage.kind === "idle" ? (
        <div className="flex flex-wrap gap-3">
          {enabled ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  start("regenerate");
                }}
              >
                {t("newRecoveryCodes")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  start("disable");
                }}
              >
                {t("turnOffTwoFactor")}
              </Button>
            </>
          ) : (
            <Button
              onClick={() => {
                start("enroll");
              }}
            >
              {t("turnOnTwoFactor")}
            </Button>
          )}
        </div>
      ) : null}

      {stage.kind === "reauth" ? (
        <form
          method="post"
          noValidate
          aria-label={t(`${stage.action}Title`)}
          onSubmit={(event) => {
            void onReauth(event);
          }}
          className="flex flex-col gap-4 rounded-control border border-line p-4"
        >
          <p className="text-body">{t(`${stage.action}Explanation`)}</p>
          {stageMode === "password" ? (
            <>
              <ReauthFields
                password={reauthForm.register("password")}
                code={reauthForm.register("code")}
                passwordError={reauthForm.formState.errors.password?.message}
                codeError={reauthForm.formState.errors.code?.message}
                withCode={enabled}
              />
              {captcha.check}
            </>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {stageMode === "google" ? (
              <ConfirmWithGoogle
                action={permission[stage.action]}
                email={email}
                userId={userId}
                twoFactor={enabled}
                label={t(`${stage.action}Submit`)}
                variant={stage.action === "disable" ? "destructive" : "primary"}
              />
            ) : (
              <Button
                type="submit"
                variant={stage.action === "disable" ? "destructive" : "primary"}
                loading={
                  reauthForm.formState.isSubmitting ||
                  busy ||
                  (stageMode === "password" && !captcha.ready)
                }
              >
                {t(`${stage.action}Submit`)}
              </Button>
            )}
            <Button variant="ghost" onClick={cancel}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {stage.kind === "scan" ? (
        <form
          method="post"
          noValidate
          aria-label={t("scanTitle")}
          onSubmit={(event) => {
            void onVerify(event);
          }}
          className="flex flex-col gap-4 rounded-control border border-line p-4"
        >
          <ol className="flex list-decimal flex-col gap-2 ps-5 text-body">
            <li>{t("scanStep1")}</li>
            <li>{t("scanStep2")}</li>
            <li>{t("scanStep3")}</li>
          </ol>
          {/* Supabase Auth returns the QR code as an SVG data URL it generated itself. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={stage.qr}
            alt={t("qrAlt")}
            width={180}
            height={180}
            // A QR code needs a light background to scan, in either theme.
            data-theme="light"
            className="rounded-control bg-surface p-2"
          />
          <div className="flex flex-col gap-1">
            <p className="text-helper text-fg-muted">{t("manualSecret")}</p>
            <code className="break-all font-mono text-body" data-testid="totp-secret">
              {stage.secret}
            </code>
          </div>
          <TextField
            label={t("authenticatorCode")}
            description={t("authenticatorCodeHint")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            required
            error={authMessages.field(codeForm.formState.errors.code?.message)}
            {...codeForm.register("code")}
          />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={codeForm.formState.isSubmitting}>
              {t("verifySubmit")}
            </Button>
            <Button variant="ghost" onClick={cancel}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
