"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { RECIPE_WIDGET_ENDPOINT, sendRecipeRequest, type RecipeWidgetData } from "@/recipes/api";
import { recipePath } from "@/recipes/format";
import type { RecipeWidgetMode } from "@/recipes/schema";

import { RecipeCover } from "./recipe-cover";
import { RatingSummary } from "./recipe-meta";

const emptyKey = {
  favorites: ["emptyFavoritesTitle", "emptyFavorites"],
  recent: ["emptyRecentTitle", "emptyRecent"],
  top_rated: ["emptyTopRatedTitle", "emptyTopRated"],
  random: ["emptyRecentTitle", "emptyRecent"],
} as const satisfies Record<RecipeWidgetMode, readonly [string, string]>;

export interface RecipeWidgetCardsProps {
  readonly homeId: string | null;
  readonly mode: RecipeWidgetMode;
  readonly count: number;
  /** The widget's own seed for Random; Show another adds a counter to it. */
  readonly seed: string;
  readonly initial: RecipeWidgetData;
}

/** The widget's cards; Random shows another pick on request (no automatic rotation). */
export function RecipeWidgetCards({ homeId, mode, count, seed, initial }: RecipeWidgetCardsProps) {
  const t = useTranslations("RecipeWidgets");
  const [round, setRound] = useState(0);
  const roundSeed = round === 0 ? seed : `${seed}:${String(round)}`;
  const picked = useQuery({
    queryKey: ["recipes", "widget", homeId ?? "personal", seed, roundSeed],
    enabled: round > 0,
    queryFn: () => {
      const params = new URLSearchParams({ mode, limit: String(count), seed: roundSeed });
      if (homeId) params.set("homeId", homeId);
      return sendRecipeRequest<RecipeWidgetData>(
        "GET",
        `${RECIPE_WIDGET_ENDPOINT}?${params.toString()}`,
      );
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const data = round === 0 ? initial : (picked.data ?? null);

  if (data && data.cards.length === 0) {
    const [title, description] = emptyKey[mode];
    return <EmptyState title={t(title)} description={t(description)} />;
  }
  return (
    <div className="flex flex-col gap-3">
      {data ? (
        <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))]">
          {data.cards.map((card) => (
            <li key={card.id} className="relative flex flex-col gap-2">
              <RecipeCover fileId={card.coverFileId} size="card" />
              <Link
                href={recipePath(homeId, card.id)}
                className="text-body font-medium text-fg after:absolute after:inset-0 hover:underline"
              >
                <bdi>{card.name}</bdi>
              </Link>
              {mode === "top_rated" ? (
                <RatingSummary average={card.ratingAverage} count={card.ratingCount} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : picked.isError ? (
        <p role="alert" className="text-body text-danger">
          {t("failed")}
        </p>
      ) : (
        <p className="text-helper text-fg-muted">{t("loading")}</p>
      )}
      {mode === "random" && initial.available > 1 ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={picked.isFetching}
            onClick={() => {
              setRound((value) => value + 1);
            }}
          >
            {t("showAnother")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
