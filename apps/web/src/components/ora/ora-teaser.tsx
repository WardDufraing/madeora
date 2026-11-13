"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { requestOraOpen } from "@/ora/open-event";
import { claimTeaser, dismissSuggestion } from "@/ora/suggestions/client";
import type { OraSuggestion } from "@/ora/suggestions/types";

/**
 * The one unsolicited note Ora may show per person per day (S47; Ora design handoff). The server
 * keeps the limit across Homes and devices (asking again anywhere answers "none") and never offers
 * one to a person who muted teasers, so this only asks and shows. It stays out of the way: a small
 * note beside the Ora button, never a modal and never taking focus, gone when Ora is opened.
 */
export function OraTeaser({
  homeId,
  hidden,
}: {
  readonly homeId: string | null;
  /** Ora's surface is open: the teaser steps aside. */
  readonly hidden: boolean;
}) {
  const t = useTranslations("Ora");
  const [teaser, setTeaser] = useState<{
    readonly suggestion: OraSuggestion;
    readonly homeId: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void claimTeaser(homeId).then((suggestion) => {
      if (!cancelled && suggestion) setTeaser({ suggestion, homeId });
    });
    return () => {
      cancelled = true;
    };
  }, [homeId]);

  // A teaser belongs to the place it was claimed in.
  if (!teaser || teaser.homeId !== homeId || hidden) return null;
  const { suggestion } = teaser;
  return (
    <div
      role="status"
      data-testid="ora-teaser"
      className="fixed bottom-[max(5rem,calc(env(safe-area-inset-bottom)+4.5rem))] end-4 z-40 flex max-w-xs flex-col gap-2 rounded-card border border-line bg-surface-elevated p-3 text-fg shadow-overlay"
    >
      <p className="text-helper">
        {t(`suggestions.${suggestion.kind}`, { count: suggestion.count })}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            setTeaser(null);
            requestOraOpen({ view: "overview", target: "today" });
          }}
        >
          {t("suggestions.open")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setTeaser(null);
            void dismissSuggestion({
              homeId,
              kind: suggestion.kind,
              situation: suggestion.situation,
            }).catch(() => undefined);
          }}
        >
          {t("suggestions.dismiss")}
        </Button>
      </div>
    </div>
  );
}
