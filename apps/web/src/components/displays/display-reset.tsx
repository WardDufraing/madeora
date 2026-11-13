"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { DISPLAY_PATH } from "@/auth/redirects";
import { resetDisplay } from "@/displays/api";

const RETRY_MS = 15_000;

/**
 * Shown when the database no longer accepts this display (S43: revoked, Home closed): it signs the
 * dead session out and reloads, so the tablet shows the pairing screen. Nothing of the Home is on
 * the page meanwhile.
 */
export function DisplayReset() {
  const t = useTranslations("Displays");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    void resetDisplay().then((done) => {
      if (cancelled) return;
      // Not reachable now: try again later instead of reloading in a loop.
      timer = setTimeout(
        () => {
          window.location.replace(DISPLAY_PATH);
        },
        done ? 0 : RETRY_MS,
      );
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return (
    <p role="status" className="text-body text-fg-muted">
      {t("notPairedAnyMore")}
    </p>
  );
}
