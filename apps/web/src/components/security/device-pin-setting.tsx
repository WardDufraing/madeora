"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { setMyDevicePin } from "@/child-sign-in/api";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, newPinSchema } from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { MemberActionError } from "@/members/manage-api";

const formSchema = z.object({ pin: newPinSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/**
 * The adult's own household-device PIN (S42 part 2; optional): with it they confirm a chore they
 * record on an approved household device, and a Home that asks for a PIN accepts their chores
 * there. It is not a way to sign in. The PIN is sent once, hashed on the server and never shown.
 */
export function DevicePinSetting({
  hasPin,
  lockedUntil,
}: {
  readonly hasPin: boolean;
  /** Formatted end of a lock after wrong PINs, if one is running. */
  readonly lockedUntil: string | null;
}) {
  const t = useTranslations("Security");
  const tPin = useTranslations("ChildSignIn");
  const router = useRouter();
  const hydrated = useHydrated();
  const [notice, setNotice] = useState<"saved" | "cleared" | null>(null);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { pin: "" },
  });
  const change = useMutation<"saved" | "unchanged" | "cleared", MemberActionError, string | null>({
    mutationFn: (pin) => setMyDevicePin({ pin }),
    onSuccess: (outcome) => {
      form.reset({ pin: "" });
      setNotice(outcome === "saved" ? "saved" : "cleared");
      router.refresh();
    },
    onError: () => {
      form.reset({ pin: "" });
    },
  });
  const problem = form.formState.errors.pin?.message;
  const submit = form.handleSubmit(({ pin }) => {
    setNotice(null);
    if (!change.isPending) change.mutate(pin);
  });

  return (
    <div className="flex flex-col gap-4" data-testid="device-pin-setting">
      <p className="text-body text-fg-muted">{t("devicePinIntro")}</p>
      <p className="text-body text-fg">{hasPin ? t("devicePinIsSet") : t("devicePinNotSet")}</p>
      {lockedUntil ? (
        <p className="text-body text-fg">{t("devicePinLocked", { time: lockedUntil })}</p>
      ) : null}
      <form
        method="post"
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <TextField
          label={t("devicePinField")}
          description={t("devicePinHint", { min: PIN_MIN_LENGTH, max: PIN_MAX_LENGTH })}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={PIN_MAX_LENGTH}
          error={
            problem === "pinTooSimple"
              ? tPin("errors.pinTooSimple")
              : problem
                ? tPin("errors.pinFormat", { min: PIN_MIN_LENGTH, max: PIN_MAX_LENGTH })
                : undefined
          }
          {...form.register("pin")}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!hydrated} loading={change.isPending}>
            {t("devicePinSave")}
          </Button>
          {hasPin ? (
            <Button
              type="button"
              variant="secondary"
              disabled={!hydrated || change.isPending}
              onClick={() => {
                setNotice(null);
                change.mutate(null);
              }}
            >
              {t("devicePinRemove")}
            </Button>
          ) : null}
        </div>
      </form>
      <MemberFailureAlert failure={change.error?.failure ?? null} />
      {notice ? (
        <FormAlert tone="success" announce>
          {notice === "saved" ? t("devicePinSaved") : t("devicePinRemoved")}
        </FormAlert>
      ) : null}
    </div>
  );
}
