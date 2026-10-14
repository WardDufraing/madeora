"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { createHome, type HomeSaveError } from "@/homes/api";
import { homeNameSchema, homeTimeZoneSchema, type HomeFieldError } from "@/homes/schema";

import { HomeFields } from "./home-fields";
import { HomeSaveFailureAlert } from "./save-failure";

const formSchema = z.object({ name: homeNameSchema, timeZone: homeTimeZoneSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

export interface CreateHomeFormProps {
  /** The person's effective timezone, offered as the Home's starting value. */
  readonly defaultTimeZone: string;
  readonly timeZoneChoices: readonly string[];
}

/**
 * Create a Home (S09): a name and the Home's scheduling timezone. The person becomes the Home's
 * single Owner. Nothing is created until they submit; leaving the page creates nothing. One
 * request id per visit to this page, so a double click or a retry after a lost answer never makes
 * a second Home.
 */
export function CreateHomeForm({ defaultTimeZone, timeZoneChoices }: CreateHomeFormProps) {
  const t = useTranslations("Homes");
  const hydrated = useHydrated();
  const router = useRouter();
  const requestId = useRef<string | null>(null);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", timeZone: defaultTimeZone },
  });
  const mutation = useMutation<{ readonly id: string }, HomeSaveError, FormOutput>({
    mutationFn: (values) => {
      requestId.current ??= crypto.randomUUID();
      return createHome({ ...values, requestId: requestId.current });
    },
    onSuccess: ({ id }) => {
      router.push(`/homes/${id}`);
    },
    onError: (error) => {
      if (error.failure === "signedOut") router.refresh();
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit((values) => {
    if (mutation.isPending || mutation.isSuccess) return;
    mutation.mutate(values);
  });

  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex max-w-xl flex-col gap-5"
    >
      <HomeFields
        name={form.register("name")}
        timeZone={form.register("timeZone")}
        nameError={errors.name?.message as HomeFieldError | undefined}
        timeZoneError={errors.timeZone?.message as HomeFieldError | undefined}
        timeZoneChoices={timeZoneChoices}
      />
      <HomeSaveFailureAlert failure={mutation.error?.failure ?? null} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={!hydrated}
          loading={mutation.isPending || mutation.isSuccess}
        >
          {t("createSubmit")}
        </Button>
        <Link href="/?context=personal" className="text-body font-medium text-accent-fg underline">
          {t("cancel")}
        </Link>
      </div>
    </form>
  );
}
