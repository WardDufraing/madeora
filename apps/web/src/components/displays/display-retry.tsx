"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { DISPLAY_PATH } from "@/auth/redirects";

const RETRY_MS = 30_000;

/** Madeora could not be asked about this display just now (S43): say so, then try again. */
export function DisplayRetry() {
  const t = useTranslations("Displays");
  useEffect(() => {
    const timer = setTimeout(() => {
      window.location.replace(DISPLAY_PATH);
    }, RETRY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <FormAlert tone="info" className="w-full max-w-md text-start">
      {t("screenUnavailable")}
    </FormAlert>
  );
}
