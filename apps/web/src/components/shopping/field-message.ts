"use client";

import { useTranslations } from "next-intl";

import type { ShoppingFieldError } from "@/shopping/schema";

const fieldKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  invalidQuantity: "fieldInvalidQuantity",
  unitNeedsQuantity: "fieldUnitNeedsQuantity",
  weekdaysRequired: "fieldWeekdaysRequired",
  invalid: "fieldInvalid",
} as const satisfies Record<ShoppingFieldError, string>;

function isFieldError(code: string): code is ShoppingFieldError {
  return Object.hasOwn(fieldKey, code);
}

/** A form field's error code (from the shopping schemas) in the viewer's language. */
export function useFieldMessage(): (code: string | undefined) => string | undefined {
  const t = useTranslations("Shopping");
  return (code) => {
    if (code === undefined) return undefined;
    return t(isFieldError(code) ? fieldKey[code] : "fieldInvalid");
  };
}
