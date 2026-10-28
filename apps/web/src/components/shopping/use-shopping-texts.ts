"use client";

import { useLocale, useTranslations } from "next-intl";

import type { ShoppingUnit } from "@madeora/domain/shopping";

import type { ShoppingFailure, ShoppingPerson } from "@/shopping/api";
import { amountText } from "@/shopping/format";
import { personName, type MemberNames } from "@/tasks/format";

const failureKey = {
  signedOut: "failureSignedOut",
  invalid: "failureInvalid",
  notFound: "failureNotFound",
  notPermitted: "failureNotPermitted",
  conflict: "failureConflict",
  duplicate: "failureDuplicate",
  duplicateName: "failureDuplicateName",
  limitReached: "failureLimitReached",
  sameList: "failureSameList",
  destinationUnavailable: "failureDestinationUnavailable",
  invalidCategory: "failureInvalidCategory",
  alreadyRepeating: "failureAlreadyRepeating",
  completed: "failureCompleted",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<ShoppingFailure, string>;

/** What a refused or failed shopping request means, in the viewer's language. */
export function useShoppingFailure(): (failure: ShoppingFailure) => string {
  const t = useTranslations("Shopping");
  return (failure) => t(failureKey[failure]);
}

const unitKey = {
  piece: "unit_piece",
  g: "unit_g",
  kg: "unit_kg",
  ml: "unit_ml",
  cl: "unit_cl",
  dl: "unit_dl",
  l: "unit_l",
} as const satisfies Record<ShoppingUnit, string>;

/** Unit labels, amounts as stored ("1,5 kg") and people, in the viewer's language. */
export function useShoppingTexts(names: MemberNames) {
  const t = useTranslations("Shopping");
  const locale = useLocale();
  const unit = (value: ShoppingUnit) => t(unitKey[value]);
  return {
    unit,
    amount: (quantity: string | null, value: ShoppingUnit | null) =>
      amountText(quantity, value, locale, unit),
    person: (person: ShoppingPerson | null): string => {
      if (person === null) return t("personAutomatic");
      const name = personName(person, names);
      switch (name.kind) {
        case "me":
          return t("personYou");
        case "member":
          return name.name;
        case "unnamed":
          return t("personUnnamed");
        default:
          return t("personFormer");
      }
    },
  };
}
