"use client";

import { useState } from "react";

import type { RecipeIngredient } from "@/recipes/api";

import { ScaledIngredients, ServingsControl } from "./scaled-ingredients";

export interface RecipeServingsProps {
  readonly ingredients: readonly RecipeIngredient[];
  readonly original: number | null;
  readonly servingsLabel: string | null;
  /** From `?servings=N`; the recipe's own yield otherwise. */
  readonly initial: number | null;
}

/** The detail page's servings selector and the ingredients for it (S24): a view, never a save. */
export function RecipeServings({
  ingredients,
  original,
  servingsLabel,
  initial,
}: RecipeServingsProps) {
  const [selected, setSelected] = useState(original === null ? 1 : (initial ?? original));
  return (
    <div className="flex flex-col gap-4">
      <ServingsControl
        original={original}
        servingsLabel={servingsLabel}
        selected={selected}
        onChange={setSelected}
      />
      <ScaledIngredients ingredients={ingredients} original={original} selected={selected} />
    </div>
  );
}
