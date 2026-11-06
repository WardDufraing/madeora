"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import {
  continueRecoverySchema,
  emailOnlySchema,
  type ContinueRecoveryValues,
  type EmailOnlyValues,
} from "@/auth/schemas";
import { getMemoryOnlySupabaseClient } from "@/auth/supabase-browser";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

/**
 * Account recovery for someone who lost both the password and the sign-in mailbox (S37; Ward,
 * 2026-11-06: backup email + account recovery code + 72-hour wait). Every step runs signed out,
 * in a client without any session; the database checks each link and code itself, limits
 * attempts and never says whether an address has an account.
 */
function recoveryClient() {
  return getMemoryOnlySupabaseClient("account-recovery");
}

/** Step 1: the lost sign-in address. A link goes to the account's backup address, if it has one. */
export function StartAccountRecovery() {
  const t = useTranslations("AccountRecovery");
  const messages = useAuthMessages();
  const hydrated = useHydrated();
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const form = useForm<EmailOnlyValues>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFailed(false);
    const { error } = await recoveryClient().rpc("start_account_recovery", {
      p_email: values.email,
    });
    if (error) {
      setFailed(true);
      return;
    }
    setSent(true);
  });

  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="success" announce>
          {t("startSent")}
        </FormAlert>
        <Link href="/sign-in" className="text-body font-medium text-accent-fg underline">
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-body">{t("startDescription")}</p>
      {failed ? (
        <FormAlert tone="error" announce>
          {messages.failure("unknown")}
        </FormAlert>
      ) : null}
      <TextField
        label={t("signInEmail")}
        type="email"
        autoComplete="email"
        required
        error={messages.field(form.formState.errors.email?.message)}
        {...form.register("email")}
      />
      <Button type="submit" disabled={!hydrated} loading={form.formState.isSubmitting}>
        {t("startSubmit")}
      </Button>
      <p className="text-helper text-fg-muted">{t("startNoBackup")}</p>
    </form>
  );
}

export interface ContinueAccountRecoveryProps {
  /** The link's token, already checked for shape by the page; null when missing or malformed. */
  readonly token: string | null;
}

/** Step 2, from the link sent to the backup address: one account recovery code starts the wait. */
export function ContinueAccountRecovery({ token }: ContinueAccountRecoveryProps) {
  const t = useTranslations("AccountRecovery");
  const format = useFormatter();
  const messages = useAuthMessages();
  const hydrated = useHydrated();
  const [failure, setFailure] = useState<string | null>(null);
  const [readyAt, setReadyAt] = useState<string | null>(null);
  const form = useForm<ContinueRecoveryValues>({
    resolver: zodResolver(continueRecoverySchema),
    defaultValues: { recoveryCode: "", lostAuthenticator: false },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    if (token === null) return;
    setFailure(null);
    const parsed = continueRecoverySchema.parse(values);
    const { data, error } = await recoveryClient().rpc("continue_account_recovery", {
      p_token: token,
      p_code: parsed.recoveryCode,
      p_lost_authenticator: parsed.lostAuthenticator,
    });
    form.setValue("recoveryCode", "");
    const row = data?.[0];
    if (error || !row) {
      setFailure(messages.failure("unknown"));
      return;
    }
    if (row.outcome === "rate_limited") {
      setFailure(messages.failure("rateLimited"));
      return;
    }
    if (row.outcome !== "waiting") {
      setFailure(t("continueInvalid"));
      return;
    }
    setReadyAt(format.dateTime(new Date(row.ready_at), { dateStyle: "full", timeStyle: "short" }));
  });

  if (token === null) {
    return <LinkInvalid message={t("linkInvalid")} />;
  }

  if (readyAt) {
    return (
      <FormAlert tone="success" announce>
        {t("continueWaiting", { date: readyAt })}
      </FormAlert>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-body">{t("continueDescription")}</p>
      {failure ? (
        <FormAlert tone="error" announce>
          {failure}
        </FormAlert>
      ) : null}
      <TextField
        label={t("accountRecoveryCode")}
        description={t("accountRecoveryCodeHint")}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        required
        error={form.formState.errors.recoveryCode ? t("accountRecoveryCodeInvalid") : undefined}
        {...form.register("recoveryCode")}
      />
      <Checkbox
        label={t("lostAuthenticator")}
        description={t("lostAuthenticatorHint")}
        {...form.register("lostAuthenticator")}
      />
      <Button type="submit" disabled={!hydrated} loading={form.formState.isSubmitting}>
        {t("continueSubmit")}
      </Button>
    </form>
  );
}

export interface FinishAccountRecoveryProps {
  readonly token: string | null;
}

/**
 * Step 3, from the link sent once the wait is over: the backup address becomes the sign-in
 * address and every session ends. Nothing happens until the button; a new password follows
 * through the ordinary reset email, which now goes to that address.
 */
export function FinishAccountRecovery({ token }: FinishAccountRecoveryProps) {
  const t = useTranslations("AccountRecovery");
  const messages = useAuthMessages();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"completed" | "invalid" | "unavailable" | "failed" | null>(
    null,
  );

  async function finish() {
    if (token === null) return;
    setBusy(true);
    const { data, error } = await recoveryClient().rpc("finish_account_recovery", {
      p_token: token,
    });
    setBusy(false);
    if (error) setOutcome("failed");
    else if (data === "completed" || data === "unavailable") setOutcome(data);
    else setOutcome("invalid");
  }

  if (token === null || outcome === "invalid") {
    return <LinkInvalid message={t("linkInvalid")} />;
  }

  if (outcome === "completed") {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="success" announce>
          {t("finishCompleted")}
        </FormAlert>
        <Link href="/forgot-password" className="text-body font-medium text-accent-fg underline">
          {t("setNewPassword")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body">{t("finishDescription")}</p>
      {outcome === "unavailable" ? (
        <FormAlert tone="error" announce>
          {t("finishUnavailable")}
        </FormAlert>
      ) : outcome === "failed" ? (
        <FormAlert tone="error" announce>
          {messages.failure("unknown")}
        </FormAlert>
      ) : null}
      <Button disabled={!hydrated} loading={busy} onClick={() => void finish()}>
        {t("finishSubmit")}
      </Button>
    </div>
  );
}

function LinkInvalid({ message }: { readonly message: string }) {
  const t = useTranslations("AccountRecovery");
  return (
    <div className="flex flex-col gap-4">
      <FormAlert tone="error" announce>
        {message}
      </FormAlert>
      <Link href="/account-recovery" className="text-body font-medium text-accent-fg underline">
        {t("startAgain")}
      </Link>
    </div>
  );
}
