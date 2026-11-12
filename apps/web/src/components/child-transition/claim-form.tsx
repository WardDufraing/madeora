"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { claimAccount, type ClaimFailure } from "@/child-transition/api";
import { claimEmailSchema } from "@/child-transition/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";

const formSchema = z.object({ email: claimEmailSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/**
 * The young person gives the email address they will sign in with (S42 part 3). A verification
 * link goes there; nothing changes until they open it and confirm.
 */
export function ClaimForm({ token }: { readonly token: string }) {
  const t = useTranslations("ChildTransition");
  const hydrated = useHydrated();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [failure, setFailure] = useState<ClaimFailure | null>(null);
  const [pending, setPending] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "" },
  });
  const submit = form.handleSubmit(async ({ email }) => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const result = await claimAccount({ token, email });
    setPending(false);
    if (result === null) setSentTo(email);
    else setFailure(result);
  });

  if (sentTo) {
    return (
      <FormAlert tone="success" announce>
        {t("emailSent", { email: sentTo })}
      </FormAlert>
    );
  }
  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-4"
      data-testid="claim-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <TextField
        label={t("emailLabel")}
        description={t("emailHint")}
        type="email"
        autoComplete="email"
        error={form.formState.errors.email ? t("fail.invalidEmail") : undefined}
        {...form.register("email")}
      />
      {failure ? (
        <FormAlert tone="error" announce>
          {t(`fail.${failure}`)}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" disabled={!hydrated} loading={pending}>
          {t("sendLink")}
        </Button>
      </div>
    </form>
  );
}
