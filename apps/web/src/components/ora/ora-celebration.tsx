"use client";

import type { OraPaletteKey } from "@madeora/design-tokens";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { claimCelebration } from "@/ora/celebrations/client";
import type { OraCelebration } from "@/ora/celebrations/types";
import type { OraMotionMode } from "@/ora/types";

import { OraCharacter } from "./ora-character";

/** How often (while the page is visible and Ora is closed) Ora checks for a fresh award. */
const CHECK_EVERY_MS = 90_000;
/** A celebration is short-lived: it steps away by itself. */
const SHOW_FOR_MS = 15_000;

/**
 * Ora's brief acknowledgement of chore points the person was really awarded in this Home (S47c; spec
 * "subtle animated achievement celebrations"). The server only answers for the person's own awards
 * that are in the ledger and not reversed, grouped, and at most once across tabs and devices, and
 * only when Ora, the celebrations switch, Quiet and quiet hours allow it, so this only asks and
 * shows. It is a small, dismissible note beside the Ora button: never a modal, never taking focus,
 * announced politely, gone by itself, and with reduced motion the character stays still (the
 * character component honours the system setting). It does not ask while Ora is open, so an award
 * is never claimed and then hidden behind the panel.
 */
export function OraCelebrationNote({
  homeId,
  hidden,
  palette,
  motion,
}: {
  readonly homeId: string | null;
  /** Ora's surface is open: nothing is asked or shown. */
  readonly hidden: boolean;
  readonly palette: OraPaletteKey;
  readonly motion: OraMotionMode;
}) {
  const t = useTranslations("Ora");
  const [shown, setShown] = useState<{
    readonly celebration: OraCelebration;
    readonly homeId: string;
  } | null>(null);

  useEffect(() => {
    if (homeId === null || hidden) return;
    let running = false;
    const ask = () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      void claimCelebration(homeId).then(({ celebration }) => {
        running = false;
        // Kept even when this effect has since ended: the claim is already committed, so the note
        // must not be lost (a Home switch hides it through its own `homeId`).
        if (celebration) setShown({ celebration, homeId });
      });
    };
    ask();
    const timer = window.setInterval(ask, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", ask);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [homeId, hidden]);

  const current = shown && shown.homeId === homeId && !hidden ? shown : null;
  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => {
      setShown(null);
    }, SHOW_FOR_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [current]);

  if (!current) return null;
  const { celebration } = current;
  return (
    <div
      role="status"
      data-testid="ora-celebration"
      className="fixed bottom-[max(9.5rem,calc(env(safe-area-inset-bottom)+9rem))] end-4 z-40 flex max-w-xs items-center gap-3 rounded-card border border-line bg-surface-elevated p-3 text-fg shadow-overlay"
    >
      <OraCharacter
        palette={palette}
        expression="cheer"
        motion={motion}
        className="w-10 shrink-0"
      />
      <p className="min-w-0 flex-1 text-helper">
        {celebration.title !== null
          ? t("celebration.chore", { points: celebration.points, title: celebration.title })
          : t("celebration.several", { count: celebration.count, points: celebration.points })}
      </p>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setShown(null);
        }}
      >
        {t("celebration.dismiss")}
      </Button>
    </div>
  );
}
