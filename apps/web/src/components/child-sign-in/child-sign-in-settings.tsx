"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { changeChildSignIn, type ChildSignInOutcome } from "@/child-sign-in/api";
import {
  newPinSchema,
  passwordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  usernameSchema,
  type ChildSignInActionInput,
} from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { MemberActionError } from "@/members/manage-api";

/** What the guardian sees, formatted on the server. Never a secret. */
export interface ChildSignInSettingsView {
  readonly username: string | null;
  readonly hasPassword: boolean;
  readonly hasPin: boolean;
  readonly passwordSignIn: boolean;
  readonly pinSignIn: boolean;
  /** A formatted time, `"guardian"` when only a guardian can unlock, or `null`. */
  readonly passwordLock: string | null;
  readonly pinLock: string | null;
  readonly activeSessions: number;
}

type Done = "username" | "password" | "pin" | "access" | "cleared" | "unlocked" | "ended";

function useSignInAction(homeId: string, membershipId: string, onDone: (done: Done) => void) {
  const router = useRouter();
  return useMutation<
    ChildSignInOutcome,
    MemberActionError,
    { readonly input: ChildSignInActionInput; readonly done: Done }
  >({
    mutationFn: ({ input }) => changeChildSignIn(homeId, membershipId, input),
    onSuccess: (_, { done }) => {
      onDone(done);
      router.refresh();
    },
  });
}

/**
 * A child's sign-in, for their guardians in this Home (S42; spec "Confirmed guardian-managed child
 * sign-in" and the guardian authority rules). The primary guardian sets the username and password
 * and turns sign-in on; either guardian sets a new PIN, turns sign-in off, lifts a lock and signs
 * the child out everywhere. PINs and passwords are sent once, hashed on the server, never shown
 * again. The API and the database decide every change again.
 */
export function ChildSignInSettings({
  homeId,
  membershipId,
  childName,
  isPrimary,
  settings,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly childName: string;
  readonly isPrimary: boolean;
  readonly settings: ChildSignInSettingsView;
}) {
  const t = useTranslations("ChildSignIn");
  const hydrated = useHydrated();
  const [done, setDone] = useState<Done | null>(null);
  const action = useSignInAction(homeId, membershipId, setDone);
  const run = (input: ChildSignInActionInput, result: Done) => {
    setDone(null);
    if (!action.isPending) action.mutate({ input, done: result });
  };

  const [passwordSignIn, setPasswordSignIn] = useState(settings.passwordSignIn);
  const [pinSignIn, setPinSignIn] = useState(settings.pinSignIn);
  const switchesChanged =
    passwordSignIn !== settings.passwordSignIn || pinSignIn !== settings.pinSignIn;
  const locked = settings.passwordLock !== null || settings.pinLock !== null;
  const lockText = (lock: string) =>
    lock === "guardian" ? t("lockedUntilGuardian") : t("lockedUntil", { time: lock });

  return (
    <div className="flex flex-col gap-6" data-testid="child-sign-in-settings">
      <p className="text-body text-fg-muted">{t("guardianIntro", { name: childName })}</p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-body font-medium text-fg">{t("usernameLabel")}</dt>
        <dd className="text-body text-fg" data-testid="child-username">
          {settings.username ?? t("notSet")}
        </dd>
        <dt className="text-body font-medium text-fg">{t("passwordLabel")}</dt>
        <dd className="text-body text-fg">{settings.hasPassword ? t("isSet") : t("notSet")}</dd>
        <dt className="text-body font-medium text-fg">{t("pinLabel")}</dt>
        <dd className="text-body text-fg">{settings.hasPin ? t("isSet") : t("notSet")}</dd>
        <dt className="text-body font-medium text-fg">{t("sessionsLabel")}</dt>
        <dd className="text-body text-fg">
          {t("sessionsCount", { count: settings.activeSessions })}
        </dd>
      </dl>
      {settings.passwordLock ? (
        <FormAlert tone="info">
          {t("passwordLocked")} {lockText(settings.passwordLock)}
        </FormAlert>
      ) : null}
      {settings.pinLock ? (
        <FormAlert tone="info">
          {t("pinLocked")} {lockText(settings.pinLock)}
        </FormAlert>
      ) : null}

      <MemberFailureAlert failure={action.error?.failure ?? null} />
      {done && !action.isPending ? (
        <FormAlert tone="success" announce>
          {t(`done.${done}`)}
        </FormAlert>
      ) : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-body font-semibold text-fg">{t("switchesLegend")}</legend>
        <Checkbox
          label={t("passwordSignInLabel")}
          description={isPrimary ? t("passwordSignInHint") : t("primaryOnlyOn")}
          checked={passwordSignIn}
          disabled={!hydrated || (!isPrimary && !settings.passwordSignIn)}
          onChange={(event) => {
            setPasswordSignIn(event.target.checked);
          }}
          data-testid="password-sign-in-switch"
        />
        <Checkbox
          label={t("pinSignInLabel")}
          description={isPrimary ? t("pinSignInHint") : t("primaryOnlyOn")}
          checked={pinSignIn}
          disabled={!hydrated || (!isPrimary && !settings.pinSignIn)}
          onChange={(event) => {
            setPinSignIn(event.target.checked);
          }}
          data-testid="pin-sign-in-switch"
        />
        <div>
          <Button
            type="button"
            disabled={!hydrated || !switchesChanged}
            loading={action.isPending && action.variables.input.action === "access"}
            onClick={() => {
              run({ action: "access", passwordSignIn, pinSignIn }, "access");
            }}
          >
            {t("saveSwitches")}
          </Button>
        </div>
      </fieldset>

      {isPrimary ? (
        <SecretForm
          kind="username"
          busy={action.isPending}
          onSubmit={(value) => {
            run({ action: "username", username: value }, "username");
          }}
          currentUsername={settings.username}
        />
      ) : null}
      {isPrimary && settings.username ? (
        <SecretForm
          kind="password"
          busy={action.isPending}
          onSubmit={(value) => {
            run({ action: "password", password: value }, "password");
          }}
        />
      ) : isPrimary ? (
        <p className="text-helper text-fg-muted">{t("passwordNeedsUsername")}</p>
      ) : null}
      <SecretForm
        kind="pin"
        busy={action.isPending}
        onSubmit={(value) => {
          run({ action: "pin", pin: value }, "pin");
        }}
      />

      <div className="flex flex-wrap gap-3">
        {locked ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!hydrated || action.isPending}
            onClick={() => {
              run({ action: "unlock" }, "unlocked");
            }}
          >
            {t("unlock")}
          </Button>
        ) : null}
        {settings.activeSessions > 0 ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!hydrated || action.isPending}
            onClick={() => {
              run({ action: "end-sessions" }, "ended");
            }}
          >
            {t("signOutEverywhere")}
          </Button>
        ) : null}
        {isPrimary && settings.hasPassword ? (
          <Button
            type="button"
            variant="ghost"
            disabled={!hydrated || action.isPending}
            onClick={() => {
              run({ action: "clear", credential: "password" }, "cleared");
            }}
          >
            {t("removePassword")}
          </Button>
        ) : null}
        {settings.hasPin ? (
          <Button
            type="button"
            variant="ghost"
            disabled={!hydrated || action.isPending}
            onClick={() => {
              run({ action: "clear", credential: "pin" }, "cleared");
            }}
          >
            {t("removePin")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const schemas = {
  username: z.object({ value: usernameSchema }),
  password: z.object({ value: passwordSchema }),
  pin: z.object({ value: newPinSchema }),
} as const;

/** One field and a save button: the username, a new password or a new PIN. */
function SecretForm({
  kind,
  busy,
  onSubmit,
  currentUsername,
}: {
  readonly kind: "username" | "password" | "pin";
  readonly busy: boolean;
  readonly onSubmit: (value: string) => void;
  readonly currentUsername?: string | null;
}) {
  const t = useTranslations("ChildSignIn");
  const hydrated = useHydrated();
  const form = useForm<{ value: string }>({
    resolver: zodResolver(schemas[kind]),
    defaultValues: { value: kind === "username" ? (currentUsername ?? "") : "" },
  });
  const error = form.formState.errors.value?.message;
  const submit = form.handleSubmit(({ value }) => {
    onSubmit(value);
    // Secrets leave the form at once; they are never kept or shown again.
    if (kind !== "username") form.reset({ value: "" });
  });
  const errorText =
    error === undefined
      ? undefined
      : t(`errors.${error}` as Parameters<typeof t>[0], {
          min: kind === "pin" ? PIN_MIN_LENGTH : PASSWORD_MIN_LENGTH,
          max: kind === "pin" ? PIN_MAX_LENGTH : PASSWORD_MAX_LENGTH,
        });

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-3"
      data-testid={`child-${kind}-form`}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <TextField
        label={t(`${kind}FieldLabel`)}
        description={t(`${kind}FieldHint`, {
          min: kind === "pin" ? PIN_MIN_LENGTH : PASSWORD_MIN_LENGTH,
          max: kind === "pin" ? PIN_MAX_LENGTH : PASSWORD_MAX_LENGTH,
        })}
        type={kind === "username" ? "text" : "password"}
        autoComplete={kind === "username" ? "off" : "new-password"}
        autoCapitalize="none"
        spellCheck={false}
        {...(kind === "pin" ? { inputMode: "numeric" as const } : {})}
        error={errorText}
        {...form.register("value")}
      />
      <div>
        <Button type="submit" variant="secondary" disabled={!hydrated || busy}>
          {t(`${kind}Save`)}
        </Button>
      </div>
    </form>
  );
}
