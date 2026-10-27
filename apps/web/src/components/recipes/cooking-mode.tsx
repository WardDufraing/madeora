"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import {
  recipeEndpoint,
  RecipeRequestError,
  sendRecipeRequest,
  type RecipeDetail,
} from "@/recipes/api";
import { recipePath, recipesPath } from "@/recipes/format";

import { ScaledIngredients, ServingsControl } from "./scaled-ingredients";

/** How often cooking mode checks whether the recipe changed (and on focus). */
export const CHECK_MS = 60_000;

export interface CookingModeProps {
  readonly recipe: RecipeDetail;
  readonly homeId: string | null;
  readonly initialServings: number | null;
}

interface Progress {
  readonly step: number;
  readonly checked: readonly number[];
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

type WakeLockState = "off" | "on" | "unsupported" | "refused";

function readProgress(key: string, steps: number): Progress {
  try {
    const text = window.sessionStorage.getItem(key);
    if (text) {
      const parsed = JSON.parse(text) as Partial<Progress>;
      const step = typeof parsed.step === "number" ? parsed.step : 0;
      return {
        step: Math.min(Math.max(0, Math.trunc(step)), Math.max(0, steps - 1)),
        checked: Array.isArray(parsed.checked)
          ? parsed.checked.filter((value): value is number => typeof value === "number")
          : [],
      };
    }
  } catch {
    // No storage in this tab: start at the beginning.
  }
  return { step: 0, checked: [] };
}

/**
 * Cooking mode (S24): one step at a time in large text with Previous and Next, the scaled
 * ingredient checklist, and keeping the screen awake where the browser allows it. The step and
 * checklist stay in this tab only. It never writes anything and takes no lock; every minute and
 * on focus it checks the recipe, and says when it changed (with Reload) or is no longer available,
 * instead of swapping content silently.
 */
export function CookingMode({ recipe, homeId, initialServings }: CookingModeProps) {
  const t = useTranslations("Recipes");
  const router = useRouter();
  const storageKey = `madeora:recipe-cook:${recipe.id}:${String(recipe.revision)}`;
  const steps = recipe.steps;
  const [progress, setProgress] = useState<Progress>({ step: 0, checked: [] });
  const [servings, setServings] = useState(
    recipe.servings === null ? 1 : (initialServings ?? recipe.servings),
  );
  const [remote, setRemote] = useState<"same" | "changed" | "gone">("same");
  const [wake, setWake] = useState<WakeLockState>("off");
  const sentinel = useRef<WakeLockSentinelLike | null>(null);
  const stepRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // The tab's own progress is known only after mounting (session storage).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProgress(readProgress(storageKey, steps.length));
  }, [storageKey, steps.length]);

  const save = (next: Progress) => {
    setProgress(next);
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Progress then lasts only while the page is open.
    }
  };

  const check = useCallback(async () => {
    try {
      const current = await sendRecipeRequest<RecipeDetail>(
        "GET",
        `${recipeEndpoint(recipe.id)}${homeId ? `?homeId=${encodeURIComponent(homeId)}` : ""}`,
      );
      setRemote(current.revision === recipe.revision ? "same" : "changed");
    } catch (error) {
      if (error instanceof RecipeRequestError && error.failure === "notFound") setRemote("gone");
      // A failed check (offline) says nothing about the recipe: keep what is shown.
    }
  }, [recipe.id, recipe.revision, homeId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void check();
    }, CHECK_MS);
    const onFocus = () => {
      void check();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  // Keep the screen awake: released when switched off or when leaving cooking mode.
  useEffect(
    () => () => {
      void sentinel.current?.release().catch(() => undefined);
      sentinel.current = null;
    },
    [],
  );

  async function toggleWake() {
    if (sentinel.current) {
      await sentinel.current.release().catch(() => undefined);
      sentinel.current = null;
      setWake("off");
      return;
    }
    if (!("wakeLock" in navigator)) {
      setWake("unsupported");
      return;
    }
    try {
      const lock: WakeLockSentinelLike = await navigator.wakeLock.request("screen");
      sentinel.current = lock;
      lock.addEventListener("release", () => {
        sentinel.current = null;
        setWake("off");
      });
      setWake("on");
    } catch {
      setWake("refused");
    }
  }

  const back = recipePath(homeId, recipe.id);
  if (remote === "gone") {
    return (
      <div className="flex flex-col gap-4" data-testid="cooking-unavailable">
        <FormAlert tone="error" announce>
          {t("cookingUnavailable")}
        </FormAlert>
        <Link href={recipesPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToLibrary")}
        </Link>
      </div>
    );
  }

  const step = progress.step;
  const checked = new Set(progress.checked);
  const go = (next: number) => {
    save({ ...progress, step: next });
    window.setTimeout(() => stepRef.current?.focus(), 0);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="cooking-mode">
      {remote === "changed" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-surface-sunken p-3">
          <p role="status" className="text-body text-fg">
            {t("cookingChanged")}
          </p>
          <Button
            size="sm"
            onClick={() => {
              router.refresh();
            }}
          >
            {t("reload")}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Link href={back} className="text-body font-medium text-accent-fg underline">
          {t("exitCooking")}
        </Link>
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={wake === "on"}
          onClick={() => void toggleWake()}
        >
          {t("keepAwake")}
        </Button>
        {wake === "unsupported" || wake === "refused" ? (
          <p role="status" className="text-helper text-fg-muted">
            {wake === "unsupported" ? t("keepAwakeUnsupported") : t("keepAwakeRefused")}
          </p>
        ) : null}
      </div>

      {steps.length === 0 ? (
        <p className="text-body text-fg-muted">
          {t("cookingNoSteps")}{" "}
          <Link href={back} className="font-medium text-accent-fg underline">
            {t("backToRecipe")}
          </Link>
        </p>
      ) : (
        <section aria-labelledby="cooking-step" className="flex flex-col gap-4">
          <h2
            id="cooking-step"
            ref={stepRef}
            tabIndex={-1}
            className="text-section-title font-semibold text-fg outline-none"
            data-testid="cooking-step-count"
          >
            {t("stepOf", { number: step + 1, total: steps.length })}
          </h2>
          <p
            className="whitespace-pre-line text-2xl leading-relaxed text-fg"
            aria-live="polite"
            data-testid="cooking-step"
          >
            {steps[step]}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              disabled={step === 0}
              onClick={() => {
                go(step - 1);
              }}
            >
              {t("previousStep")}
            </Button>
            <Button
              disabled={step >= steps.length - 1}
              onClick={() => {
                go(step + 1);
              }}
              data-testid="cooking-next"
            >
              {t("nextStep")}
            </Button>
          </div>
        </section>
      )}

      {recipe.ingredients.length > 0 ? (
        <section aria-labelledby="cooking-ingredients" className="flex flex-col gap-3">
          <h2 id="cooking-ingredients" className="text-section-title font-semibold text-fg">
            {t("ingredientsHeading")}
          </h2>
          <ServingsControl
            original={recipe.servings}
            servingsLabel={recipe.servingsLabel}
            selected={servings}
            onChange={setServings}
          />
          <ScaledIngredients
            ingredients={recipe.ingredients}
            original={recipe.servings}
            selected={servings}
            checklist={{
              checked,
              onToggle: (index) => {
                const next = new Set(checked);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                save({ ...progress, checked: [...next] });
              },
            }}
          />
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                save({ ...progress, checked: [] });
              }}
            >
              {t("resetChecklist")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
