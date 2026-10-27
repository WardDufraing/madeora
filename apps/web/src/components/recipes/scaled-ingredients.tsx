"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  formatQuantity,
  isValidServings,
  RECIPE_LIMITS,
  scaleQuantity,
  type Quantity,
  type RecipeUnit,
} from "@madeora/domain/recipes";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { RecipeIngredient } from "@/recipes/api";

/** Each unit's name for exactly one, and for any other amount (the same for symbols). */
const unitKey = {
  g: ["unitG", "unitG"],
  kg: ["unitKg", "unitKg"],
  mg: ["unitMg", "unitMg"],
  ml: ["unitMl", "unitMl"],
  cl: ["unitCl", "unitCl"],
  dl: ["unitDl", "unitDl"],
  l: ["unitL", "unitL"],
  tsp: ["unitTsp", "unitTsp"],
  tbsp: ["unitTbsp", "unitTbsp"],
  cup: ["unitCup", "unitCupPlural"],
  fl_oz: ["unitFlOz", "unitFlOz"],
  oz: ["unitOz", "unitOz"],
  lb: ["unitLb", "unitLb"],
  piece: ["unitPiece", "unitPiecePlural"],
  pinch: ["unitPinch", "unitPinchPlural"],
  clove: ["unitClove", "unitClovePlural"],
  slice: ["unitSlice", "unitSlicePlural"],
  can: ["unitCan", "unitCanPlural"],
  jar: ["unitJar", "unitJarPlural"],
  pack: ["unitPack", "unitPackPlural"],
  bunch: ["unitBunch", "unitBunchPlural"],
  sprig: ["unitSprig", "unitSprigPlural"],
  handful: ["unitHandful", "unitHandfulPlural"],
} as const satisfies Record<RecipeUnit, readonly [string, string]>;

/** A unit's name for an amount (singular only for exactly one), or its name in a picker. */
export function useUnitLabel(): (unit: RecipeUnit, quantity: Quantity | null) => string {
  const t = useTranslations("Recipes");
  return (unit, quantity) => {
    const [one, other] = unitKey[unit];
    return t(quantity && quantity.num === quantity.den ? one : other);
  };
}

/** Keeps the selected servings in the address (`?servings=N`) without reloading the page. */
function rememberServings(selected: number, original: number | null) {
  const url = new URL(window.location.href);
  if (selected === original) url.searchParams.delete("servings");
  else url.searchParams.set("servings", String(selected));
  window.history.replaceState(window.history.state, "", url);
}

export interface ServingsControlProps {
  /** The recipe's yield; null: scaling is off. */
  readonly original: number | null;
  readonly servingsLabel: string | null;
  readonly selected: number;
  readonly onChange: (servings: number) => void;
}

/**
 * The serving count to show the ingredients for (S24): fewer and more buttons and a number field
 * (1–999). The original yield stays visible. Without a recorded yield it says why there is no
 * scaling instead of assuming one.
 */
export function ServingsControl({
  original,
  servingsLabel,
  selected,
  onChange,
}: ServingsControlProps) {
  const t = useTranslations("Recipes");
  const [text, setText] = useState(String(selected));
  const [shown, setShown] = useState(selected);
  if (shown !== selected) {
    setShown(selected);
    setText(String(selected));
  }
  if (original === null) {
    return <p className="text-helper text-fg-muted">{t("noYield")}</p>;
  }
  const label = servingsLabel ?? t("servingsDefaultLabel");
  const set = (value: number) => {
    if (!isValidServings(value)) return;
    onChange(value);
    rememberServings(value, original);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="servings-control">
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-label={t("fewerServings")}
          disabled={selected <= RECIPE_LIMITS.minServings}
          onClick={() => {
            set(selected - 1);
          }}
        >
          {"−"}
        </Button>
        <label className="flex flex-col gap-1 text-helper text-fg-muted">
          {t("servingsFieldLabel", { label })}
          <input
            type="number"
            inputMode="numeric"
            min={RECIPE_LIMITS.minServings}
            max={RECIPE_LIMITS.maxServings}
            step={1}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              const value = Number(event.target.value);
              if (/^\d{1,3}$/.test(event.target.value) && isValidServings(value)) set(value);
            }}
            className="h-8 w-20 rounded-control border border-line-control bg-surface px-2 text-body text-fg"
            data-testid="servings-input"
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          aria-label={t("moreServings")}
          disabled={selected >= RECIPE_LIMITS.maxServings}
          onClick={() => {
            set(selected + 1);
          }}
        >
          +
        </Button>
        {selected !== original ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              set(original);
            }}
          >
            {t("resetServings")}
          </Button>
        ) : null}
      </div>
      <p className="text-helper text-fg-muted" aria-live="polite" data-testid="servings-summary">
        {selected === original
          ? t("servingsOriginal", { count: original, label })
          : t("servingsScaled", { count: selected, original, label })}
      </p>
    </div>
  );
}

export interface ScaledIngredientsProps {
  readonly ingredients: readonly RecipeIngredient[];
  readonly original: number | null;
  readonly selected: number;
  /** Cooking mode: each ingredient is a checkbox for this tab. */
  readonly checklist?: {
    readonly checked: ReadonlySet<number>;
    readonly onToggle: (index: number) => void;
  };
}

/**
 * The ingredient list for the selected servings: exact arithmetic, the original amounts when no
 * scaling applies, rounded amounts marked "≈" with the exact value on request, and amount-less
 * ingredients unchanged and labelled while scaled.
 */
export function ScaledIngredients({
  ingredients,
  original,
  selected,
  checklist,
}: ScaledIngredientsProps) {
  const t = useTranslations("Recipes");
  const locale = useLocale();
  const unitLabel = useUnitLabel();
  const [exact, setExact] = useState(false);
  const scaling = original !== null && selected !== original;
  const rows = ingredients.map((ingredient) => {
    const quantity =
      ingredient.quantity && scaling
        ? (scaleQuantity(ingredient.quantity, original, selected) ?? ingredient.quantity)
        : ingredient.quantity;
    const display = quantity ? formatQuantity(quantity, locale) : null;
    return { ingredient, quantity, display };
  });
  const anyApproximate = rows.some((row) => row.display?.approximate);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2" data-testid="recipe-ingredients">
        {rows.map(({ ingredient, quantity, display }, index) => {
          const amount = display
            ? `${display.approximate && !exact ? "≈ " : ""}${exact ? display.exact : display.text}`
            : null;
          const unit = ingredient.unit ? unitLabel(ingredient.unit, quantity) : null;
          const text = (
            <span className="text-body text-fg">
              {amount ? <span className="font-semibold">{amount}</span> : null}
              {amount && unit ? " " : null}
              {unit ? <span className="font-semibold">{unit}</span> : null}
              {amount || unit ? " " : null}
              <bdi>{ingredient.name}</bdi>
              {ingredient.note ? (
                <span className="text-fg-muted">
                  {", "}
                  <bdi>{ingredient.note}</bdi>
                </span>
              ) : null}
              {display?.approximate && !exact ? (
                <span className="sr-only">{t("approximateAmount", { exact: display.exact })}</span>
              ) : null}
              {scaling && !ingredient.quantity ? (
                <span className="text-helper text-fg-muted"> {t("notScaled")}</span>
              ) : null}
            </span>
          );
          return (
            // Ingredients may repeat by name; their position is their identity here.
            <li key={index}>
              {checklist ? (
                <label className="flex min-h-10 cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={checklist.checked.has(index)}
                    onChange={() => {
                      checklist.onToggle(index);
                    }}
                    className="mt-1 size-5 shrink-0 accent-accent"
                  />
                  <span className={checklist.checked.has(index) ? "line-through opacity-70" : ""}>
                    {text}
                  </span>
                </label>
              ) : (
                text
              )}
            </li>
          );
        })}
      </ul>
      {anyApproximate ? (
        <div>
          <Checkbox
            label={t("showExactAmounts")}
            checked={exact}
            onChange={(event) => {
              setExact(event.target.checked);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
