"use client";

import { useTranslations } from "next-intl";

/** A vacation's shown name: its own, or the generic "Home vacation". Works in client components. */
export function useVacationName() {
  const t = useTranslations("Vacations");
  return (name: string | null) => name ?? t("genericName");
}
