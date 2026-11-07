"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import {
  abandonGoogleReauth,
  authorizeAfterGoogle,
  confirmedPath,
  openGoogleReauthSession,
  takePending,
  type GoogleReauthFailure,
  type PendingGoogleReauth,
  verifyReauthCode,
} from "@/auth/google-reauth";
import { totpCodeSchema, type TotpCodeValues } from "@/auth/schemas";
import { classifyTwoFactorError } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

import { useTwoFactorMessages } from "./reauth-fields";

type Outcome =
  | { readonly kind: "working" }
  | { readonly kind: "code"; readonly pending: PendingGoogleReauth }
  | { readonly kind: "failed"; readonly failure: GoogleReauthFailure };

async function finish(pending: PendingGoogleReauth): Promise<Outcome | null> {
  if (!(await authorizeAfterGoogle(pending.action))) return { kind: "failed", failure: "refused" };
  window.location.assign(new URL(confirmedPath(pending.action), window.location.origin));
  return null;
}

async function begin(): Promise<Outcome | null> {
  const params = new URLSearchParams(window.location.search);
  // The one-time code and any error text leave the address bar (and the history) at once.
  window.history.replaceState(window.history.state, "", window.location.pathname);
  const pending = takePending();
  if (!pending) return { kind: "failed", failure: "nothingPending" };
  if (params.has("error")) return { kind: "failed", failure: "cancelled" };
  const failure = await openGoogleReauthSession(pending, params.get("code"));
  if (failure) return { kind: "failed", failure };
  if (pending.twoFactor) return { kind: "code", pending };
  return finish(pending);
}

/**
 * Finishes "Confirm with Google" (S37): opens the short-lived Google session, asks for the
 * authenticator code when two-factor sign-in is on (verified on the Google session), asks
 * the database for the permission and goes back to the change, which then needs nothing more.
 */
export function GoogleReauthCallback() {
  const t = useTranslations("Security");
  const authMessages = useAuthMessages();
  const codeMessage = useTwoFactorMessages();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "working" });
  const [failure, setFailure] = useState<string | null>(null);
  const started = useRef(false);
  const form = useForm<TotpCodeValues>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: "" },
  });

  useEffect(() => {
    // The code is single-use: never run twice (React may mount effects twice in development).
    if (started.current) return;
    started.current = true;
    begin().then(
      (result) => {
        if (result) setOutcome(result);
      },
      () => {
        setOutcome({ kind: "failed", failure: "failed" });
      },
    );
  }, []);

  const onCode = form.handleSubmit(async (values) => {
    if (outcome.kind !== "code") return;
    setFailure(null);
    // On the Google session: the browser's own is aal2 here, so neither ends the other.
    const { error, noFactor } = await verifyReauthCode("google", totpCodeSchema.parse(values).code);
    if (noFactor) {
      setFailure(authMessages.failure("unknown"));
      return;
    }
    if (error) {
      setFailure(codeMessage(classifyTwoFactorError(error)));
      form.setValue("code", "");
      form.setFocus("code");
      return;
    }
    const result = await finish(outcome.pending);
    if (result) setOutcome(result);
  });

  if (outcome.kind === "working") {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("googleConfirmWorking")}
      </p>
    );
  }

  if (outcome.kind === "code") {
    return (
      <form
        method="post"
        noValidate
        onSubmit={(event) => {
          void onCode(event);
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-body">{t("googleConfirmCode")}</p>
        {failure ? (
          <FormAlert tone="error" announce>
            {failure}
          </FormAlert>
        ) : null}
        <TextField
          label={t("authenticatorCode")}
          description={t("authenticatorCodeHint")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={9}
          required
          error={authMessages.field(form.formState.errors.code?.message)}
          {...form.register("code")}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={form.formState.isSubmitting}>
            {t("challengeSubmit")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void abandonGoogleReauth().then(() => {
                window.location.assign(new URL("/settings/security", window.location.origin));
              });
            }}
          >
            {t("cancel")}
          </Button>
        </div>
      </form>
    );
  }

  const messages: Record<GoogleReauthFailure, string> = {
    cancelled: t("googleConfirmCancelled"),
    nothingPending: t("googleConfirmNothingPending"),
    otherAccount: t("googleConfirmOtherAccount"),
    refused: t("reauthRequired"),
    failed: t("googleConfirmFailed"),
  };
  return (
    <div className="flex flex-col gap-4">
      <FormAlert tone={outcome.failure === "cancelled" ? "info" : "error"} announce>
        {messages[outcome.failure]}
      </FormAlert>
      <Link href="/settings/security" className="text-body font-medium text-accent-fg underline">
        {t("backToSecurity")}
      </Link>
    </div>
  );
}
