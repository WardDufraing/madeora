"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { recipeEndpoint, sendRecipeRequest, type RatingAnswer } from "@/recipes/api";

import { RatingSummary } from "./recipe-meta";
import { useRecipeFailure } from "./use-recipe-texts";
import { useRecipeMutation } from "./use-recipe-mutation";

export interface RecipeFavoriteProps {
  readonly recipeId: string;
  readonly favorite: boolean;
}

/** The viewer's own favorite mark for this recipe in its context (S24); a toggle button. */
export function RecipeFavorite({ recipeId, favorite }: RecipeFavoriteProps) {
  const t = useTranslations("Recipes");
  const failure = useRecipeFailure();
  const { announce, region } = useAnnouncer();
  const [shown, setShown] = useState(favorite);
  const [server, setServer] = useState(favorite);
  if (server !== favorite) {
    setServer(favorite);
    setShown(favorite);
  }
  const mutation = useRecipeMutation(
    `recipe:${recipeId}:favorite`,
    (next: boolean) =>
      sendRecipeRequest<{ favorite: boolean }>(
        next ? "PUT" : "DELETE",
        recipeEndpoint(recipeId, "favorite"),
        {},
      ),
    (_result, next) => {
      announce(next ? t("announceFavorited") : t("announceUnfavorited"));
    },
  );
  return (
    <HydrationGate>
      {region}
      <div className="flex flex-col gap-2">
        <Button
          variant="secondary"
          aria-pressed={shown}
          loading={mutation.busy}
          onClick={() => {
            const next = !shown;
            setShown(next);
            mutation.mutate(next, {
              onError: () => {
                setShown(!next);
              },
            });
          }}
          data-testid="recipe-favorite"
        >
          <span aria-hidden="true">{shown ? "★" : "☆"}</span>
          {t("favoriteToggle")}
        </Button>
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
      </div>
    </HydrationGate>
  );
}

export interface RecipeRatingProps {
  readonly recipeId: string;
  readonly rating: {
    readonly mine: number | null;
    readonly average: number | null;
    readonly count: number;
  };
}

/**
 * The viewer's 1–5 star rating (S24): a radio group, changeable and clearable, with the context's
 * average and count. Never anyone else's own rating or who rated.
 */
export function RecipeRating({ recipeId, rating }: RecipeRatingProps) {
  const t = useTranslations("Recipes");
  const failure = useRecipeFailure();
  const { announce, region } = useAnnouncer();
  const [summary, setSummary] = useState<RatingAnswer>(rating);
  const [server, setServer] = useState(rating);
  if (server !== rating) {
    setServer(rating);
    setSummary(rating);
  }
  const mutation = useRecipeMutation(
    `recipe:${recipeId}:rating`,
    (stars: number | null) =>
      sendRecipeRequest<RatingAnswer>(
        stars === null ? "DELETE" : "PUT",
        recipeEndpoint(recipeId, "rating"),
        stars === null ? {} : { stars },
      ),
    (answer) => {
      setSummary(answer);
      announce(
        answer.mine === null
          ? t("announceRatingCleared")
          : t("announceRated", { stars: answer.mine }),
      );
    },
  );
  return (
    <HydrationGate>
      {region}
      <fieldset className="flex flex-col gap-2" data-testid="recipe-rating">
        <legend className="text-body font-medium text-fg">{t("yourRating")}</legend>
        <div className="flex flex-wrap items-center gap-1">
          {[1, 2, 3, 4, 5].map((stars) => (
            <label
              key={stars}
              className="relative inline-flex size-10 cursor-pointer items-center justify-center rounded-control text-section-title text-accent-fg has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
            >
              <input
                type="radio"
                name={`rating-${recipeId}`}
                value={stars}
                checked={summary.mine === stars}
                onChange={() => {
                  mutation.mutate(stars);
                }}
                className="sr-only"
              />
              <span aria-hidden="true">
                {summary.mine !== null && stars <= summary.mine ? "★" : "☆"}
              </span>
              <span className="sr-only">{t("starsLabel", { count: stars })}</span>
            </label>
          ))}
          {summary.mine !== null ? (
            <Button
              variant="ghost"
              size="sm"
              loading={mutation.busy}
              onClick={() => {
                mutation.mutate(null);
              }}
            >
              {t("clearRating")}
            </Button>
          ) : null}
        </div>
        <p data-testid="rating-summary">
          <RatingSummary average={summary.average} count={summary.count} />
        </p>
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
      </fieldset>
    </HydrationGate>
  );
}
