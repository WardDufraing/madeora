"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useMemo, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";

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

/** What an attempt came to: done (the page moves on), a fresh confirmation needed, or a message. */
export type ActionResult =
  | { readonly kind: "done" }
  | { readonly kind: "reauthenticate" }
  | { readonly kind: "message"; readonly message: string };

export interface ReauthenticatedActionProps {
  readonly action: AccountChangeAction;
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  /** The action this page came back to after confirming with Google, if any. */
  readonly confirmed: AccountChangeAction | null;
  /** Where Google returns to, when not the action's own page. */
  readonly returnPath?: string;
  /** The button's words, and the sentence above the confirmation. */
  readonly label: string;
  readonly confirmIntro: string;
  readonly variant?: "primary" | "destructive";
  /** Checks the page's own inputs first; returns a message to show, or null to go on. */
  readonly validate?: () => string | null;
  readonly perform: () => Promise<ActionResult>;
  /** The page's own inputs, above the button. */
  readonly children?: ReactNode;
  readonly testId?: string;
}

/**
 * A destructive account or Home action behind a fresh "confirm it's you" (S37): the action is
 * tried first; when the database asks for a fresh confirmation, the password (and code) form or
 * the Google confirmation appears, and the action is tried once more afterwards. Used by account
 * deletion and by closing and restoring a Home (S40).
 */
export function ReauthenticatedAction({
  action,
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  returnPath,
  label,
  confirmIntro,
  variant = "destructive",
  validate,
  perform,
  children,
  testId,
}: ReauthenticatedActionProps) {
  const t = useTranslations("Deletion");
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, action);
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
  async function attempt(): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await perform();
      if (result.kind === "reauthenticate") return false;
      if (result.kind === "message") setMessage(result.message);
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const invalid = validate?.() ?? null;
    if (invalid !== null) {
      setMessage(invalid);
      return;
    }
    if (!(await attempt())) setAsking(true);
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
        client.rpc("authorize_account_change", { p_action: action, p_session_id: sessionId }),
    );
    captcha.reset();
    form.reset({ password: "", code: "" });
    if (failed) {
      setMessage(reauthMessage(failed));
      return;
    }
    setAsking(false);
    if (!(await attempt())) setMessage(t("failed"));
  });

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      {message ? (
        <FormAlert tone="error" announce>
          {message}
        </FormAlert>
      ) : null}
      {asking ? (
        mode === "google" ? (
          <div className="flex flex-col gap-3 rounded-control border border-line p-4">
            <p className="text-body">{confirmIntro}</p>
            <ConfirmWithGoogle
              action={action}
              email={email}
              userId={userId}
              twoFactor={twoFactor}
              label={label}
              variant={variant}
              returnPath={returnPath}
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
            aria-label={confirmIntro}
            onSubmit={(event) => {
              void onConfirm(event);
            }}
            className="flex flex-col gap-4 rounded-control border border-line p-4"
          >
            <p className="text-body">{confirmIntro}</p>
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
                variant={variant}
                loading={form.formState.isSubmitting || busy || !captcha.ready}
              >
                {label}
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
          {children}
          <div>
            <Button
              variant={variant}
              loading={busy}
              onClick={() => {
                void start();
              }}
            >
              {label}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
