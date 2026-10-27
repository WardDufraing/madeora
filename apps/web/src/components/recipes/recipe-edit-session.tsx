"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/states";
import { recipePath } from "@/recipes/format";
import type { RecipeFormValues } from "@/recipes/schema";
import { memberNames, personName, type MemberOption } from "@/tasks/format";

import { RecipeEditor } from "./recipe-editor";
import { useRecipeLock } from "./use-recipe-lock";
import { useRecipeFailure } from "./use-recipe-texts";

export interface RecipeEditSessionProps {
  readonly recipeId: string;
  readonly homeId: string | null;
  readonly revision: number;
  readonly initial: RecipeFormValues;
  readonly members: readonly MemberOption[];
  /** Shared with other Homes, or seen from one it is shared with (S25): a save changes it everywhere. */
  readonly shared: boolean;
}

/**
 * Editing a published recipe (S24): the editor opens only under the exclusive lock. Someone else's
 * lock shows who holds it (or "another tab or device" for the person's own, with Take over); a
 * lock that lapsed keeps the changes on the page with a way to continue; a recipe changed in the
 * meantime is reloaded before editing, never overwritten. A shared recipe says that saving
 * changes it in every Home it is shared with (S25).
 */
export function RecipeEditSession({
  recipeId,
  homeId,
  revision,
  initial,
  members,
  shared,
}: RecipeEditSessionProps) {
  const t = useTranslations("Recipes");
  const router = useRouter();
  const failureText = useRecipeFailure();
  const lock = useRecipeLock(recipeId, homeId);
  const names = useMemo(() => memberNames(members), [members]);
  const back = recipePath(homeId, recipeId);
  const state = lock.state;

  // The lock answered a newer revision than this page shows: read the recipe again first.
  const stale = state.kind === "held" && state.revision !== revision;
  useEffect(() => {
    if (stale) router.refresh();
  }, [stale, router]);

  if (state.kind === "acquiring" || stale) {
    return <LoadingState label={t("openingEditor")} />;
  }
  if (state.kind === "locked") {
    const person = personName({ me: false, member: state.member }, names);
    return (
      <div className="flex flex-col gap-4" data-testid="recipe-locked">
        <FormAlert tone="info">
          {state.mine
            ? t("lockedByYou")
            : state.member === null
              ? t("lockedBySomeone")
              : t("lockedBy", {
                  person:
                    person.kind === "member"
                      ? person.name
                      : person.kind === "unnamed"
                        ? t("personUnnamed")
                        : t("personFormer"),
                })}
        </FormAlert>
        <div className="flex flex-wrap gap-2">
          {state.mine ? (
            <Button
              onClick={() => {
                void lock.acquire(true);
              }}
              data-testid="recipe-take-over"
            >
              {t("takeOver")}
            </Button>
          ) : null}
          <Link href={back} className="text-body font-medium text-accent-fg underline">
            {t("backToRecipe")}
          </Link>
        </div>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="error" announce>
          {failureText(state.failure)}
        </FormAlert>
        <Link href={back} className="text-body font-medium text-accent-fg underline">
          {t("backToRecipe")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {shared ? (
        <div data-testid="recipe-shared-warning">
          <FormAlert tone="info">{t("sharedEditWarning")}</FormAlert>
        </div>
      ) : null}
      {lock.warning ? (
        <FormAlert tone="info" announce>
          {t("inactivityWarning")}{" "}
          <Button variant="secondary" size="sm" onClick={lock.touch}>
            {t("keepEditing")}
          </Button>
        </FormAlert>
      ) : null}
      {state.kind === "lapsed" ? (
        <div className="flex flex-col gap-2" data-testid="recipe-lock-lapsed">
          <FormAlert tone="info" announce>
            {state.reason === "inactive" ? t("lockLapsedInactive") : t("lockLapsedLost")}
          </FormAlert>
          <div>
            <Button
              onClick={() => {
                void lock.acquire(false);
              }}
            >
              {t("continueEditing")}
            </Button>
          </div>
        </div>
      ) : null}
      <RecipeEditor
        key={revision}
        mode="published"
        recipeId={recipeId}
        homeId={homeId}
        revision={revision}
        initial={initial}
        homes={[]}
        lockToken={lock.token}
        locked={state.kind !== "held"}
        onLockLost={lock.lose}
        onConflict={() => {
          lock.lose();
        }}
        onCancel={() => {
          void lock.release().then(() => {
            router.push(back);
          });
        }}
      />
    </div>
  );
}
