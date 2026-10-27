"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { recipeEndpoint, sendRecipeRequest } from "@/recipes/api";
import { recipesPath } from "@/recipes/format";

import { useRecipeFailure } from "./use-recipe-texts";
import { useRecipeMutation } from "./use-recipe-mutation";

/**
 * "Remove from this Home" (S25): a recipe manager of a Home a recipe is shared with removes it from
 * that Home after a confirmation. The recipe itself stays where it lives, and in any other Home.
 */
export function RecipeUnshareHere({
  recipeId,
  homeId,
}: {
  readonly recipeId: string;
  readonly homeId: string;
}) {
  const t = useTranslations("Recipes");
  const router = useRouter();
  const failure = useRecipeFailure();
  const [confirming, setConfirming] = useState(false);
  const mutation = useRecipeMutation(
    `recipe:${recipeId}:share`,
    () => sendRecipeRequest<object>("DELETE", recipeEndpoint(recipeId, "shares"), { homeId }),
    () => {
      setConfirming(false);
      router.push(`${recipesPath(homeId)}?unshared=1`);
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
        data-testid="recipe-unshare-here"
      >
        {t("unshareHere")}
      </Button>
      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={t("unshareHereTitle")}
        description={t("unshareHereBody")}
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
              data-testid="recipe-unshare-here-confirm"
            >
              {t("unshareHere")}
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
