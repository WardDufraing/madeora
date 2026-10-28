"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/states";
import {
  recipeEndpoint,
  RecipeRequestError,
  sendRecipeRequest,
  type RecipeDeleteImpact,
  type RecipeFailure,
} from "@/recipes/api";

import { useRecipeFailure } from "./use-recipe-texts";
import { useRecipeMutation } from "./use-recipe-mutation";

export interface RecipeDeleteProps {
  readonly recipeId: string;
  readonly draft: boolean;
  /** Where to go afterwards (the library or My drafts), which says it went to the trash. */
  readonly after: string;
  /** The share panel, for "Remove from one Home instead" (S25); null when not offered. */
  readonly sharePath?: string | null;
}

type Review =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly impact: RecipeDeleteImpact }
  | { readonly kind: "failed"; readonly failure: RecipeFailure };

/**
 * Moves a recipe to the trash, or discards a draft (to the personal trash), after a confirmation
 * (S24). Restorable for 7 days with its cover. Someone else editing it now refuses the delete.
 * S25: a published recipe first gets an impact review (spec "impact-reviewed deletion of shared
 * recipes"): the Homes it is shared with, its favorites and whether someone is editing it, with
 * "Remove from one Home" as the gentler choice. The review's token goes back with the delete, so
 * a recipe or share list that changed meanwhile asks for a fresh look instead of deleting.
 */
export function RecipeDelete({ recipeId, draft, after, sharePath = null }: RecipeDeleteProps) {
  const t = useTranslations("Recipes");
  const router = useRouter();
  const failure = useRecipeFailure();
  const [confirming, setConfirming] = useState(false);
  const [review, setReview] = useState<Review>({ kind: "loading" });
  const [stale, setStale] = useState(false);

  async function loadReview() {
    setReview({ kind: "loading" });
    try {
      const impact = await sendRecipeRequest<RecipeDeleteImpact>(
        "GET",
        recipeEndpoint(recipeId, "delete-impact"),
      );
      setReview({ kind: "ready", impact });
    } catch (error) {
      setReview({
        kind: "failed",
        failure: error instanceof RecipeRequestError ? error.failure : "failed",
      });
    }
  }

  const mutation = useRecipeMutation(
    `recipe:${recipeId}`,
    (impactToken: string | null) =>
      sendRecipeRequest<object>(
        "DELETE",
        recipeEndpoint(recipeId),
        impactToken ? { impactToken } : {},
      ),
    () => {
      setConfirming(false);
      router.push(`${after}?deleted=1`);
    },
    { refresh: false },
  );

  const impact = review.kind === "ready" ? review.impact : null;
  const shared = impact !== null && impact.shares.length > 0;
  const ready = draft || (impact !== null && !impact.beingEdited);

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          mutation.reset();
          setStale(false);
          setConfirming(true);
          if (!draft) void loadReview();
        }}
        data-testid="recipe-delete"
      >
        {draft ? t("discardDraft") : t("deleteRecipe")}
      </Button>
      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={
          draft ? t("discardDraftTitle") : shared ? t("deleteSharedTitle") : t("deleteRecipeTitle")
        }
        description={draft ? t("discardDraftBody") : t("deleteRecipeBody")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={mutation.busy}
              disabled={!ready}
              onClick={() => {
                mutation.mutate(draft ? null : (impact?.token ?? null), {
                  onError: (error) => {
                    // The recipe or its shares changed since the review: look again first.
                    if (
                      error.failure === "staleImpact" ||
                      error.failure === "impactReviewRequired"
                    ) {
                      setStale(true);
                      void loadReview();
                    }
                  },
                });
              }}
              data-testid="recipe-delete-confirm"
            >
              {draft ? t("discardDraft") : shared ? t("deleteEverywhere") : t("deleteRecipe")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3" data-testid="recipe-delete-impact">
          {draft ? null : review.kind === "loading" ? (
            <LoadingState label={t("impactLoading")} />
          ) : review.kind === "failed" ? (
            <FormAlert tone="error" announce>
              {failure(review.failure)}
            </FormAlert>
          ) : (
            <ImpactDetails impact={review.impact} sharePath={sharePath} />
          )}
          {stale ? (
            <FormAlert tone="info" announce>
              {t("impactChanged")}
            </FormAlert>
          ) : mutation.error ? (
            <FormAlert tone="error" announce>
              {failure(mutation.error.failure)}
            </FormAlert>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

function ImpactDetails({
  impact,
  sharePath,
}: {
  readonly impact: RecipeDeleteImpact;
  readonly sharePath: string | null;
}) {
  const t = useTranslations("Recipes");
  return (
    <>
      {impact.shares.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-body text-fg">{t("impactShared", { count: impact.shares.length })}</p>
          <ul className="list-disc ps-6 text-body text-fg" data-testid="recipe-impact-homes">
            {impact.shares.map((share) => (
              <li key={share.homeId}>
                <bdi>{share.homeName}</bdi>
              </li>
            ))}
          </ul>
          {sharePath ? (
            <p className="text-body">
              <Link href={sharePath} className="font-medium text-accent-fg underline">
                {t("impactUnshareInstead")}
              </Link>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-body text-fg">{t("impactNotShared")}</p>
      )}
      <p className="text-body text-fg">
        {impact.favoriteCount > 0
          ? t("impactFavorites", { count: impact.favoriteCount })
          : t("impactNoFavorites")}
      </p>
      {impact.plannedMeals > 0 || impact.repeatingMeals > 0 ? (
        <p className="text-body text-fg" data-testid="recipe-impact-meals">
          {t("impactMeals", { planned: impact.plannedMeals, repeating: impact.repeatingMeals })}
        </p>
      ) : null}
      {impact.beingEdited ? (
        <FormAlert tone="info" announce>
          {t("impactBeingEdited")}
        </FormAlert>
      ) : null}
      <p className="text-helper text-fg-muted">{t("impactTrash")}</p>
    </>
  );
}
