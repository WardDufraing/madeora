"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { useNow } from "@/components/ui/use-now";
import { localeNames } from "@/i18n/locales";
import {
  createInvitation,
  type CreatedInvitationResponse,
  type InvitationActionError,
} from "@/invitations/api";
import { expiryDurationMs, formatDateTime, type DateTimeFormats } from "@/invitations/format";
import {
  ACTIVE_INVITATION_LIMIT,
  DEFAULT_EXPIRY,
  MAX_MULTI_USE,
  MIN_MULTI_USE,
  emailLanguages,
  expiryChoices,
  invitationFormSchema,
  toCreateInvitation,
  type EmailLanguage,
  type InvitationFieldError,
  type InvitationFormValues,
  type InvitationKind,
} from "@/invitations/schema";

import { CopyButton } from "./copy-button";
import { InvitationFailureAlert } from "./failure-alert";

export interface InviteFormProps {
  readonly homeId: string;
  /** Whether this person may invite Administrators (the Owner only). */
  readonly canInviteAdministrators: boolean;
  /** Whether this environment can send email; otherwise only links and codes are offered. */
  readonly emailEnabled: boolean;
  readonly defaultLanguage: EmailLanguage;
  readonly activeCount: number;
  readonly formats: DateTimeFormats;
}

type Created = CreatedInvitationResponse["invitation"] & { readonly email?: string };

const fieldErrorKey = {
  emailRequired: "emailRequired",
  emailInvalid: "emailInvalid",
  maxUsesInvalid: "maxUsesInvalid",
} as const satisfies Record<InvitationFieldError, string>;

const expiryKey = { "24h": "expiry24h", "7d": "expiry7d", "30d": "expiry30d" } as const;

/**
 * "Invite someone" (S10): an email invitation, an invitation link or a join code, with the role,
 * expiry and usage the spec allows. The chosen expiry is shown before creating. One request id per
 * attempt series, so a double click or a retry never creates two invitations. Afterwards the
 * link or code is shown with a copy button, and the list below is refreshed from the server.
 */
export function InviteForm({
  homeId,
  canInviteAdministrators,
  emailEnabled,
  defaultLanguage,
  activeCount,
  formats,
}: InviteFormProps) {
  const t = useTranslations("Invitations");
  const tHomes = useTranslations("Homes");
  const hydrated = useHydrated();
  const router = useRouter();
  // One request id per attempt series of the same invitation: kept for a retry after a network
  // failure, replaced when the fields change (the server refuses an id reused for other content).
  const pendingRequest = useRef<{ readonly id: string; readonly content: string } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const now = useNow();

  const form = useForm<InvitationFormValues>({
    resolver: zodResolver(invitationFormSchema),
    defaultValues: {
      kind: emailEnabled ? "email" : "link",
      role: "member",
      email: "",
      language: defaultLanguage,
      expiresIn: DEFAULT_EXPIRY,
      usage: "single",
      maxUses: String(MIN_MULTI_USE),
    },
  });
  const [kind, usage, expiresIn] = useWatch({
    control: form.control,
    name: ["kind", "usage", "expiresIn"],
  });
  const errors = form.formState.errors;

  const mutation = useMutation<Created, InvitationActionError, InvitationFormValues>({
    mutationFn: async (values) => {
      const content = JSON.stringify(toCreateInvitation(invitationFormSchema.parse(values), ""));
      if (pendingRequest.current?.content !== content) {
        pendingRequest.current = { id: crypto.randomUUID(), content };
      }
      const input = toCreateInvitation(
        invitationFormSchema.parse(values),
        pendingRequest.current.id,
      );
      const invitation = await createInvitation(homeId, input);
      return input.kind === "email" ? { ...invitation, email: input.email } : invitation;
    },
    onSuccess: (invitation) => {
      pendingRequest.current = null;
      setCreated(invitation);
      form.reset({ ...form.getValues(), email: "" });
      router.refresh();
    },
    onError: (error) => {
      if (error.failure === "signedOut") router.refresh();
      // Refused for good: the next attempt is a new request.
      if (error.failure !== "network" && error.failure !== "failed") pendingRequest.current = null;
    },
  });

  useEffect(() => {
    if (created) resultHeading.current?.focus();
  }, [created]);

  const limitReached = activeCount >= ACTIVE_INVITATION_LIMIT;
  const fieldError = (message: string | undefined) =>
    message && message in fieldErrorKey
      ? t(fieldErrorKey[message as InvitationFieldError])
      : undefined;
  const effectiveExpiry = kind === "email" ? "7d" : expiresIn;
  const expiryPreview =
    now === null
      ? null
      : formatDateTime(new Date(now + expiryDurationMs[effectiveExpiry]), formats);
  const showRole = kind !== "join_code" && canInviteAdministrators;

  const onSubmit = form.handleSubmit((values) => {
    if (mutation.isPending) return;
    setCreated(null);
    mutation.mutate(values);
  });

  const kinds: readonly { readonly value: InvitationKind; readonly disabled: boolean }[] = [
    { value: "email", disabled: !emailEnabled },
    { value: "link", disabled: false },
    { value: "join_code", disabled: false },
  ];

  return (
    <div className="flex flex-col gap-5">
      {limitReached ? (
        <FormAlert tone="info">{t("limitReached", { limit: ACTIVE_INVITATION_LIMIT })}</FormAlert>
      ) : null}
      <form
        method="post"
        noValidate
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        className="flex max-w-xl flex-col gap-5"
      >
        <fieldset className="flex flex-col gap-1" disabled={limitReached}>
          <legend className="mb-2 text-body font-medium text-fg">{t("kindLegend")}</legend>
          {kinds.map((option) => (
            <RadioOption
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              label={t(
                option.value === "email"
                  ? "kindEmail"
                  : option.value === "link"
                    ? "kindLink"
                    : "kindJoinCode",
              )}
              description={
                option.value === "email"
                  ? emailEnabled
                    ? t("kindEmailHint")
                    : t("kindEmailUnavailable")
                  : option.value === "link"
                    ? t("kindLinkHint")
                    : t("kindJoinCodeHint")
              }
              {...form.register("kind")}
            />
          ))}
        </fieldset>

        {kind === "email" ? (
          <div className="flex flex-col gap-5">
            <TextField
              label={t("emailLabel")}
              description={t("emailHint")}
              type="email"
              autoComplete="off"
              required
              disabled={limitReached}
              error={fieldError(errors.email?.message)}
              {...form.register("email")}
            />
            <SelectField
              label={t("languageLabel")}
              description={t("languageHint")}
              disabled={limitReached}
              options={emailLanguages.map((language) => ({
                value: language,
                label: localeNames[language],
              }))}
              {...form.register("language")}
            />
          </div>
        ) : null}

        {showRole ? (
          <fieldset className="flex flex-col gap-1" disabled={limitReached}>
            <legend className="mb-2 text-body font-medium text-fg">{t("roleLegend")}</legend>
            <RadioOption
              value="member"
              label={tHomes("roleMember")}
              description={t("roleMemberHint")}
              {...form.register("role")}
            />
            <RadioOption
              value="administrator"
              label={tHomes("roleAdministrator")}
              description={t("roleAdministratorHint")}
              {...form.register("role")}
            />
          </fieldset>
        ) : (
          <p className="text-body text-fg-muted">
            {t("roleFixed", { role: tHomes("roleMember") })}
          </p>
        )}

        {kind === "link" || kind === "join_code" ? (
          <SelectField
            label={t("expiryLabel")}
            disabled={limitReached}
            options={expiryChoices.map((choice) => ({
              value: choice,
              label: t(expiryKey[choice]),
            }))}
            {...form.register("expiresIn")}
          />
        ) : null}

        {kind === "link" ? (
          <fieldset className="flex flex-col gap-1" disabled={limitReached}>
            <legend className="mb-2 text-body font-medium text-fg">{t("usageLegend")}</legend>
            <RadioOption
              value="single"
              label={t("usageSingle")}
              description={t("usageSingleHint")}
              {...form.register("usage")}
            />
            <RadioOption
              value="multi"
              label={t("usageMulti")}
              description={t("usageMultiHint", { min: MIN_MULTI_USE, max: MAX_MULTI_USE })}
              {...form.register("usage")}
            />
            {usage === "multi" ? (
              <TextField
                className="mt-2 max-w-48 ps-8"
                label={t("maxUsesLabel")}
                type="number"
                inputMode="numeric"
                min={MIN_MULTI_USE}
                max={MAX_MULTI_USE}
                required
                error={
                  errors.maxUses
                    ? t("maxUsesInvalid", { min: MIN_MULTI_USE, max: MAX_MULTI_USE })
                    : undefined
                }
                {...form.register("maxUses")}
              />
            ) : null}
          </fieldset>
        ) : null}

        <p className="text-body text-fg" data-testid="expiry-preview">
          {expiryPreview
            ? kind === "email"
              ? t("expiryPreviewEmail", { date: expiryPreview })
              : t("expiryPreview", { date: expiryPreview })
            : t(kind === "email" ? "expiryEmailFixed" : expiryKey[effectiveExpiry])}
        </p>

        <InvitationFailureAlert failure={mutation.error?.failure ?? null} />
        <div>
          <Button type="submit" disabled={!hydrated || limitReached} loading={mutation.isPending}>
            {kind === "email"
              ? t("submitEmail")
              : kind === "link"
                ? t("submitLink")
                : t("submitCode")}
          </Button>
        </div>
      </form>

      {created ? (
        <section
          aria-labelledby="invitation-created"
          className="flex max-w-xl flex-col gap-3 rounded-card border border-line bg-surface p-4"
        >
          <h3
            id="invitation-created"
            ref={resultHeading}
            tabIndex={-1}
            className="text-body font-semibold text-fg"
          >
            {created.kind === "email"
              ? created.delivery === "sent"
                ? t("createdEmailSent", { email: created.email ?? "" })
                : t("createdEmailNotSent", { email: created.email ?? "" })
              : created.kind === "link"
                ? t("createdLink")
                : t("createdCode")}
          </h3>
          {created.kind === "email" && created.delivery !== "sent" ? (
            <p className="text-body text-fg-muted">
              {created.delivery === "not_configured"
                ? t("deliveryNotConfiguredHint")
                : t("deliveryFailedHint")}
            </p>
          ) : null}
          {created.code ? (
            <p className="font-mono text-section-title font-semibold tracking-widest text-fg">
              {created.code}
            </p>
          ) : null}
          {created.url ? (
            <div className="flex flex-col gap-2">
              <TextField label={t("linkLabel")} readOnly value={created.url} />
              <div className="flex flex-wrap gap-2">
                <CopyButton text={created.url} label={t("copyLink")} />
                {created.code ? <CopyButton text={created.code} label={t("copyCode")} /> : null}
              </div>
            </div>
          ) : null}
          <p className="text-helper text-fg-muted">
            {t("createdExpires", { date: formatDateTime(created.expiresAt, formats) })}
          </p>
        </section>
      ) : null}
    </div>
  );
}
