"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import { looksLikeJoinCode } from "@/invitations/schema";

const codeFormSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "codeRequired")
    .refine((value) => looksLikeJoinCode(value), "codeInvalid"),
});
type CodeFormValues = z.input<typeof codeFormSchema>;
type CodeFieldError = "codeRequired" | "codeInvalid";

/**
 * "Enter a join code" (S10). Checks only the shape here; the code then opens the same page as an
 * invitation link, which shows the Home and the role before the person asks to join. Whether a
 * code exists is only ever answered by that page, which counts failed lookups.
 */
export function JoinCodeForm() {
  const t = useTranslations("Invitations");
  const router = useRouter();
  const hydrated = useHydrated();
  const [navigating, setNavigating] = useState(false);
  const form = useForm<CodeFormValues>({
    resolver: zodResolver(codeFormSchema),
    defaultValues: { code: "" },
  });
  const error = form.formState.errors.code?.message;

  const onSubmit = form.handleSubmit(({ code }) => {
    setNavigating(true);
    const compact = code
      .trim()
      .replace(/[\s-]+/g, "")
      .toUpperCase();
    router.push(`/join/${encodeURIComponent(compact)}`);
  });

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex max-w-md flex-col gap-4"
    >
      <TextField
        label={t("codeLabel")}
        description={t("codeHint")}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        required
        error={error ? t(error as CodeFieldError) : undefined}
        {...form.register("code")}
      />
      <div>
        <Button type="submit" disabled={!hydrated} loading={navigating}>
          {t("codeSubmit")}
        </Button>
      </div>
    </form>
  );
}
