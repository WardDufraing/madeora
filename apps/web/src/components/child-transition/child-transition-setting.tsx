"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  cancelTransition,
  startTransition,
  type StartTransitionResult,
} from "@/child-transition/api";
import { birthDateSchema } from "@/child-transition/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { MemberActionError } from "@/members/manage-api";

export interface ChildTransitionView {
  readonly open: boolean;
  /** Formatted end of the open claim link. */
  readonly claimExpires: string | null;
  readonly emailGiven: boolean;
  readonly requiredAge: number;
  readonly canStart: boolean;
}

const formSchema = z.object({ birthDate: birthDateSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/**
 * A child's move to their own independent account (S42 part 3), for their guardians. The primary
 * guardian of every Home of the child enters the birth date; when the child is old enough for all
 * their Homes, a claim link is shown once to give to them. Nothing changes until the young person
 * confirms from their own email address, and any guardian of the child may cancel before that.
 */
export function ChildTransitionSetting({
  homeId,
  membershipId,
  childName,
  state,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly childName: string;
  readonly state: ChildTransitionView;
}) {
  const t = useTranslations("ChildTransition");
  const format = useFormatter();
  const router = useRouter();
  const hydrated = useHydrated();
  const [result, setResult] = useState<StartTransitionResult | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { birthDate: "" },
  });
  const start = useMutation<StartTransitionResult, MemberActionError, FormOutput>({
    mutationFn: (values) => startTransition(homeId, membershipId, values),
    onSuccess: (value) => {
      setResult(value);
      form.reset({ birthDate: "" });
      router.refresh();
    },
  });
  const cancel = useMutation<undefined, MemberActionError, undefined>({
    mutationFn: async () => {
      await cancelTransition(homeId, membershipId);
      return undefined;
    },
    onSuccess: () => {
      setResult(null);
      setCancelled(true);
      router.refresh();
    },
  });
  const submit = form.handleSubmit((values) => {
    setResult(null);
    setCancelled(false);
    if (!start.isPending) start.mutate(values);
  });
  const day = (value: string) =>
    format.dateTime(new Date(`${value}T12:00:00Z`), { dateStyle: "long", timeZone: "UTC" });

  return (
    <div className="flex flex-col gap-4" data-testid="child-transition">
      <p className="text-body text-fg-muted">
        {t("intro", { name: childName, age: state.requiredAge })}
      </p>
      {state.open ? (
        <div className="flex flex-col gap-3">
          <p className="text-body text-fg">
            {t("openUntil", { time: state.claimExpires ?? "" })}
            {state.emailGiven ? ` ${t("emailGiven", { name: childName })}` : ""}
          </p>
          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={!hydrated}
              loading={cancel.isPending}
              onClick={() => {
                cancel.mutate(undefined);
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {result?.outcome === "started" ? (
        <FormAlert tone="success" announce>
          {t("started", { name: childName })}
        </FormAlert>
      ) : null}
      {result?.outcome === "started" ? (
        <TextField
          label={t("claimLinkLabel")}
          description={t("claimLinkHint", {
            name: childName,
            time: format.dateTime(new Date(result.expiresAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
          readOnly
          value={result.claimUrl}
          onFocus={(event) => {
            event.target.select();
          }}
        />
      ) : null}
      {result?.outcome === "not_eligible" ? (
        <FormAlert tone="info" announce>
          {t("notEligible", { name: childName, date: day(result.eligibleOn) })}
        </FormAlert>
      ) : null}
      {cancelled ? (
        <FormAlert tone="success" announce>
          {t("cancelled")}
        </FormAlert>
      ) : null}
      <MemberFailureAlert failure={(start.error ?? cancel.error)?.failure ?? null} />
      {state.canStart ? (
        <form
          method="post"
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <TextField
            label={t("birthDateLabel", { name: childName })}
            description={t("birthDateHint")}
            type="date"
            autoComplete="off"
            error={form.formState.errors.birthDate ? t("birthDateInvalid") : undefined}
            {...form.register("birthDate")}
          />
          <div>
            <Button type="submit" disabled={!hydrated} loading={start.isPending}>
              {state.open ? t("restart") : t("start")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-body text-fg-muted">{t("onlyPrimaryEverywhere", { name: childName })}</p>
      )}
    </div>
  );
}
