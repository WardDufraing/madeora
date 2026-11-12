"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";

import { DISPLAY_PATH } from "@/auth/redirects";
import { resetDisplay, sendHeartbeat } from "@/displays/api";

/** How often the display checks that the server still accepts it (and is noted as seen). */
const HEARTBEAT_MS = 60_000;

function subscribeSeconds(onChange: () => void): () => void {
  const timer = setInterval(onChange, 1_000);
  return () => {
    clearInterval(timer);
  };
}
const secondNow = () => Math.floor(Date.now() / 1_000) * 1_000;

/**
 * A paired Household Display (S43). It shows only what is safe on a communal screen: its own name,
 * its Home's name and the time and date in the Home's timezone. The shared dashboard, privacy lock
 * and member actions come with S44.
 *
 * Every minute it asks the server whether it is still accepted. When it was revoked or its Home
 * closed, it clears the screen at once and returns to the pairing screen (spec: "a revoked or reset
 * display returns to the unpaired screen without showing cached sensitive Home data"). When the
 * server cannot be reached it says so and keeps the same harmless screen.
 */
export function PairedDisplay({
  displayName,
  homeName,
  timeZone,
}: {
  readonly displayName: string;
  readonly homeName: string;
  readonly timeZone: string;
}) {
  const t = useTranslations("Displays");
  const locale = useLocale();
  const now = useSyncExternalStore(subscribeSeconds, secondNow, () => null);
  const [connection, setConnection] = useState<"online" | "offline" | "leaving">("online");

  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      const result = await sendHeartbeat();
      if (stopped) return;
      if (result === "not-paired") {
        setConnection("leaving");
        await resetDisplay();
        window.location.replace(DISPLAY_PATH);
        return;
      }
      setConnection(result === "ok" ? "online" : "offline");
    };
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (connection === "leaving") {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("notPairedAnyMore")}
      </p>
    );
  }

  const time =
    now === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: timeZone,
        }).format(now);
  const date =
    now === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          weekday: "long",
          day: "numeric",
          month: "long",
          timeZone: timeZone,
        }).format(now);

  return (
    <div className="flex flex-col items-center gap-4" data-testid="paired-display">
      <h1 className="text-page-title font-semibold text-fg">
        <bdi>{homeName}</bdi>
      </h1>
      <p className="font-mono text-[4rem] leading-none font-semibold text-fg">{time ?? " "}</p>
      <p className="text-section-title text-fg-muted">{date ?? " "}</p>
      <p className="text-helper text-fg-muted">{t("pairedAs", { name: displayName })}</p>
      <p role="status" className="text-helper text-fg-muted" data-testid="display-connection">
        {connection === "offline" ? t("offline") : null}
      </p>
    </div>
  );
}
