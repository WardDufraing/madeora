"use client";

import { useTranslations } from "next-intl";
import { z } from "zod";

import { dateOnlySchema } from "@/tasks/schema";

/** One person's stay in a form: a member and their own inclusive dates. */
export const stayRowSchema = z
  .object({
    memberId: z.string().min(1, "memberRequired"),
    startsOn: z
      .union([z.literal(""), dateOnlySchema])
      .refine((value) => value !== "", "dateRequired"),
    endsOn: z
      .union([z.literal(""), dateOnlySchema])
      .refine((value) => value !== "", "dateRequired"),
  })
  .refine((stay) => stay.startsOn === "" || stay.endsOn === "" || stay.endsOn >= stay.startsOn, {
    message: "endBeforeStart",
    path: ["endsOn"],
  });

/** Dates alone, for changing or proposing a stay and for absences. */
export const datesSchema = z
  .object({
    startsOn: z
      .union([z.literal(""), dateOnlySchema])
      .refine((value) => value !== "", "dateRequired"),
    endsOn: z
      .union([z.literal(""), dateOnlySchema])
      .refine((value) => value !== "", "dateRequired"),
  })
  .refine((stay) => stay.endsOn >= stay.startsOn, { message: "endBeforeStart", path: ["endsOn"] });

const fieldErrorKey = {
  tooLong: "errorTooLong",
  memberRequired: "errorMemberRequired",
  dateRequired: "errorDateRequired",
  endBeforeStart: "errorEndBeforeStart",
  duplicateMember: "errorDuplicateMember",
  reminderRange: "errorReminderRange",
  invalidCharacters: "errorInvalidCharacters",
} as const;

/** A field's message from the codes the vacation forms use. */
export function useVacationFieldMessage() {
  const t = useTranslations("Vacations");
  return (error: { readonly message?: string | undefined } | undefined) => {
    const key = error?.message;
    return key && key in fieldErrorKey
      ? t(fieldErrorKey[key as keyof typeof fieldErrorKey])
      : undefined;
  };
}
