"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { recipeEndpoint, sendRecipeRequest } from "@/recipes/api";

import { useRecipeFailure } from "./use-recipe-texts";
import { useRecipeMutation } from "./use-recipe-mutation";

export interface RecipeDeleteProps {
  readonly recipeId: string;
  readonly draft: boolean;
  /** Where to go afterwards (the library or My drafts), which says it went to the trash. */
  readonly after: string;
}

/**
 * Moves a recipe to the trash, or discards a draft (to the personal trash), after a confirmation
 * (S24). Restorable for 7 days with its cover. Someone else editing it now refuses the delete.
 */
export function RecipeDelete({ recipeId, draft, after }: RecipeDeleteProps) {
  const t = useTranslations("Recipes");
  const router = useRouter();
  const failure = useRecipeFailure();
  const [confirming, setConfirming] = useState(false);
  const mutation = useRecipeMutation(
    `recipe:${recipeId}`,
    () => sendRecipeRequest<object>("DELETE", recipeEndpoint(recipeId), {}),
    () => {
      setConfirming(false);
      router.push(`${after}?deleted=1`);
    },
    { refresh: false },
  );
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          mutation.reset();
          setConfirming(true);
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
        title={draft ? t("discardDraftTitle") : t("deleteRecipeTitle")}
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
              onClick={() => {
                mutation.mutate(undefined);
              }}
              data-testid="recipe-delete-confirm"
            >
              {draft ? t("discardDraft") : t("deleteRecipe")}
            </Button>
          </>
        }
      >
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
      </Dialog>
    </>
  );
}
