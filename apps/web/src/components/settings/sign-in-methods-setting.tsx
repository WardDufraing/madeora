"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { reauthenticateSchema, type ReauthenticateValues } from "@/auth/schemas";
import {
  LINK_STARTED_BY_KEY,
  canUnlink,
  classifyMethodChangeError,
  type MethodChangeFailure,
  type SignInMethodsView,
} from "@/auth/sign-in-methods";
import { getMemoryOnlySupabaseClient, getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import { useAuthMessages } from "@/components/auth/use-auth-messages";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";

export interface SignInMethodsSettingProps {
  readonly userId: string;
  readonly methods: SignInMethodsView;
  /** Whether Supabase Auth has Google switched on; linking is only offered then. */
  readonly googleAvailable: boolean;
  /** Set after returning from a link or unlink, to confirm what changed. */
  readonly notice: "linked" | "unlinked" | null;
}

type Action = "link" | "unlink";

/**
 * Proves the person knows the password with a separate, memory-only sign-in, then asks the
 * database for a one-time permission with that fresh session. The browser's own session is never
 * replaced, and the extra session is signed out straight away.
 */
async function reauthenticateFor(
  action: Action,
  email: string,
  password: string,
  captchaOptions: { readonly captchaToken?: string },
): Promise<unknown> {
  const client = getMemoryOnlySupabaseClient("reauthentication");
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
    options: captchaOptions,
  });
  if (signInError) return signInError;
  try {
    const { error } = await client.rpc("authorize_sign_in_method_change", {
      p_action: action,
      p_provider: "google",
    });
    return error;
  } finally {
    await client.auth.signOut({ scope: "local" });
  }
}

/** Settings › Sign-in methods (S08): email and password, and linking or unlinking Google. */
export function SignInMethodsSetting({
  userId,
  methods,
  googleAvailable,
  notice,
}: SignInMethodsSettingProps) {
  const t = useTranslations("SignInMethods");
  const authMessages = useAuthMessages();
  const captcha = useCaptcha("reauthenticate");
  const [action, setAction] = useState<Action | null>(null);
  const [failure, setFailure] = useState<MethodChangeFailure | null>(null);
  const [leaving, setLeaving] = useState(false);
  const form = useForm<ReauthenticateValues>({
    resolver: zodResolver(reauthenticateSchema),
    defaultValues: { password: "" },
  });
  const { errors, isSubmitting } = form.formState;

  // Opening the form moves focus to the password field it asks for.
  useEffect(() => {
    if (action !== null) form.setFocus("password");
  }, [action, form]);

  const failures: Record<MethodChangeFailure, string> = {
    wrongPassword: t("wrongPassword"),
    reauthRequired: t("reauthRequired"),
    notAllowed: t("notAllowed"),
    alreadyLinked: t("linkAlreadyLinked"),
    unavailable: t("unavailable"),
    rateLimited: authMessages.failure("rateLimited"),
    captchaFailed: authMessages.failure("captchaFailed"),
    network: authMessages.failure("network"),
    unknown: authMessages.failure("unknown"),
  };

  function open(next: Action) {
    setAction(next);
    setFailure(null);
    form.reset({ password: "" });
  }

  function close() {
    setAction(null);
    setFailure(null);
    form.reset({ password: "" });
  }

  const onSubmit = form.handleSubmit(async ({ password }) => {
    if (action === null || !captcha.ready) return;
    setFailure(null);
    const reauthError = await reauthenticateFor(action, methods.email, password, captcha.options);
    captcha.reset();
    form.setValue("password", "");
    if (reauthError) {
      setFailure(classifyMethodChangeError(reauthError));
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (action === "link") {
      try {
        window.sessionStorage.setItem(LINK_STARTED_BY_KEY, userId);
      } catch {
        // Without session storage the callback cannot confirm the account and says so.
      }
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("flow", "link");
      const { error } = await supabase.auth.linkIdentity({
        provider: "google",
        options: { redirectTo: callback.toString(), queryParams: { prompt: "select_account" } },
      });
      // On success the browser is already on its way to Google.
      if (error) setFailure(classifyMethodChangeError(error));
      else setLeaving(true);
      return;
    }

    const { data, error: listError } = await supabase.auth.getUserIdentities();
    const google = data?.identities.find((identity) => identity.provider === "google");
    if (listError || !google) {
      setFailure(listError ? classifyMethodChangeError(listError) : "notAllowed");
      return;
    }
    const { error } = await supabase.auth.unlinkIdentity(google);
    if (error) {
      setFailure(classifyMethodChangeError(error));
      return;
    }
    setLeaving(true);
    window.location.assign(
      new URL("/settings?unlinked=google#sign-in-methods", window.location.origin),
    );
  });

  const googleRemovable = canUnlink(methods, "google");

  return (
    <div className="flex flex-col gap-5">
      {notice === "linked" ? (
        <FormAlert tone="success" announce>
          {t("linkedNotice")}
        </FormAlert>
      ) : null}
      {notice === "unlinked" ? (
        <FormAlert tone="success" announce>
          {t("unlinkedNotice")}
        </FormAlert>
      ) : null}

      <ul className="flex flex-col divide-y divide-line">
        <li className="flex flex-col gap-1 pb-4">
          <h3 className="text-body font-semibold">{t("passwordMethod")}</h3>
          <p className="text-body text-fg-muted">{t("accountEmail", { email: methods.email })}</p>
          <p className="text-body">{methods.password ? t("passwordSet") : t("passwordNotSet")}</p>
          {methods.password ? null : (
            <p className="text-helper text-fg-muted">{t("passwordNotSetHint")}</p>
          )}
        </li>
        <li className="flex flex-col gap-2 pt-4">
          <h3 className="text-body font-semibold">{t("googleMethod")}</h3>
          <p className="text-body">
            {methods.google === null
              ? t("googleNotConnected")
              : methods.google.email === null
                ? t("googleConnected")
                : t("googleConnectedAs", { email: methods.google.email })}
          </p>
          {methods.google === null && !googleAvailable ? (
            <p className="text-helper text-fg-muted">{t("googleNotOffered")}</p>
          ) : null}
          {methods.google !== null && !googleRemovable ? (
            <p className="text-helper text-fg-muted">{t("lastMethodHint")}</p>
          ) : null}
          {action === null ? (
            <div>
              {methods.google === null && methods.password && googleAvailable ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    open("link");
                  }}
                >
                  {t("linkGoogle")}
                </Button>
              ) : null}
              {googleRemovable ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    open("unlink");
                  }}
                >
                  {t("unlinkGoogle")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </li>
      </ul>

      {action !== null ? (
        <form
          method="post"
          noValidate
          aria-label={action === "link" ? t("linkGoogle") : t("unlinkGoogle")}
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          className="flex flex-col gap-4 rounded-control border border-line p-4"
        >
          <p className="text-body">
            {action === "link"
              ? t("linkExplanation", { email: methods.email })
              : t("unlinkExplanation")}
          </p>
          {failure ? (
            <FormAlert tone="error" announce>
              {failures[failure]}
            </FormAlert>
          ) : null}
          <TextField
            label={t("currentPassword")}
            description={t("currentPasswordHint")}
            type="password"
            autoComplete="current-password"
            required
            error={authMessages.field(errors.password?.message)}
            {...form.register("password")}
          />
          {captcha.check}
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant={action === "unlink" ? "destructive" : "primary"}
              loading={isSubmitting || leaving || !captcha.ready}
            >
              {action === "link" ? t("confirmLink") : t("confirmUnlink")}
            </Button>
            <Button variant="ghost" disabled={isSubmitting || leaving} onClick={close}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
