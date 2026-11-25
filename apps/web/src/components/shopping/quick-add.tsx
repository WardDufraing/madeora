"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { parseShoppingQuantity, shoppingUnits } from "@madeora/domain/shopping";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import {
  sendShoppingRequest,
  ShoppingRequestError,
  shoppingListEndpoint,
  type ShoppingAddResult,
} from "@/shopping/api";
import { itemNameSchema, unitSchema } from "@/shopping/schema";

import { useFieldMessage } from "./field-message";
import { useShoppingFailure, useShoppingTexts } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

/** Sends rows to a list's items endpoint and answers with the per-row results. */
export async function addShoppingItems(
  listId: string,
  items: readonly object[],
): Promise<readonly ShoppingAddResult[]> {
  const answer = await sendShoppingRequest<{ results: readonly ShoppingAddResult[] }>(
    "POST",
    shoppingListEndpoint(listId, "items"),
    { items },
  );
  return answer.results;
}

const refusal = {
  invalid: "invalid",
  limit_reached: "limitReached",
  not_found: "notFound",
  not_permitted: "notPermitted",
  id_taken: "failed",
} as const;

/**
 * Quick add (S26): only a name; details are edited afterwards. The item's id is kept until it is
 * saved, so Try again after a lost answer never adds it twice. An active item with the same name
 * (ignoring case and accents) asks first: Add anyway or Cancel; nothing is merged.
 */
export function QuickAdd({
  listId,
  categories = [],
  onAdded,
}: {
  readonly listId: string;
  /** The list's categories, offered under Details when there are any. */
  readonly categories?: readonly { readonly id: string; readonly name: string }[];
  readonly onAdded?: (name: string) => void;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const message = useFieldMessage();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [itemId, setItemId] = useState(() => crypto.randomUUID());
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const texts = useShoppingTexts({ byId: new Map(), selfId: null });
  // Optional details (quantity, unit, category) stay hidden until asked for; the default entry is
  // only a name. A category chosen for one item is kept for the next, as list context.
  const [details, setDetails] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [quantityError, setQuantityError] = useState<string | undefined>(undefined);

  const add = useShoppingMutation(
    `shopping-add:${listId}`,
    async ({
      value,
      allowDuplicate,
      extra,
    }: {
      value: string;
      allowDuplicate: boolean;
      extra: object;
    }) => {
      const [result] = await addShoppingItems(listId, [
        { id: itemId, name: value, allowDuplicate, ...extra },
      ]);
      const outcome = result?.outcome ?? "invalid";
      if (outcome === "created" || outcome === "exists") return { value, outcome };
      if (outcome === "duplicate") return { value, outcome };
      throw new ShoppingRequestError(refusal[outcome]);
    },
    ({ value, outcome }) => {
      if (outcome === "duplicate") {
        setDuplicate(value);
        return;
      }
      setDuplicate(null);
      setName("");
      setQuantity("");
      setUnit("");
      setItemId(crypto.randomUUID());
      onAdded?.(value);
      input.current?.focus();
    },
  );

  const submit = (allowDuplicate: boolean) => {
    const parsed = itemNameSchema.safeParse(name);
    if (!parsed.success) {
      setFieldError(message(parsed.error.issues[0]?.message));
      input.current?.focus();
      return;
    }
    setFieldError(undefined);
    const extra: { quantity?: string; unit?: string; categoryId?: string } = {};
    if (details) {
      if (quantity.trim() !== "") {
        const parsedQuantity = parseShoppingQuantity(quantity);
        if (parsedQuantity === null) {
          setQuantityError(message("invalidQuantity"));
          return;
        }
        extra.quantity = parsedQuantity;
      }
      const parsedUnit = unitSchema.safeParse(unit);
      if (parsedUnit.success) {
        if (extra.quantity === undefined) {
          setQuantityError(message("unitNeedsQuantity"));
          return;
        }
        extra.unit = parsedUnit.data;
      }
      if (categoryId !== "") extra.categoryId = categoryId;
    }
    setQuantityError(undefined);
    add.mutate({ value: parsed.data, allowDuplicate, extra });
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      aria-label={t("quickAddLabel")}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          ref={input}
          label={t("quickAddField")}
          className="min-w-0 flex-1"
          autoComplete="off"
          value={name}
          error={fieldError}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setDuplicate(null);
          }}
          data-testid="shopping-quick-add"
        />
        <Button type="submit" loading={add.busy} data-testid="shopping-quick-add-submit">
          {t("add")}
        </Button>
      </div>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={details}
          onClick={() => {
            setDetails((open) => !open);
          }}
          data-testid="shopping-quick-add-details"
        >
          {details ? t("quickAddHideDetails") : t("quickAddShowDetails")}
        </Button>
      </div>
      {details ? (
        <div className="grid gap-3 sm:grid-cols-3" data-testid="shopping-quick-add-extra">
          <TextField
            label={t("fieldQuantity")}
            inputMode="decimal"
            autoComplete="off"
            value={quantity}
            error={quantityError}
            onChange={(event) => {
              setQuantity(event.currentTarget.value);
            }}
            data-testid="shopping-quick-add-quantity"
          />
          <SelectField
            label={t("fieldUnit")}
            value={unit}
            options={[
              { value: "", label: t("unitNone") },
              ...shoppingUnits.map((value) => ({ value, label: texts.unit(value) })),
            ]}
            onChange={(event) => {
              setUnit(event.currentTarget.value);
            }}
            data-testid="shopping-quick-add-unit"
          />
          {categories.length > 0 ? (
            <SelectField
              label={t("fieldCategory")}
              value={categoryId}
              options={[
                { value: "", label: t("uncategorized") },
                ...categories.map((category) => ({ value: category.id, label: category.name })),
              ]}
              onChange={(event) => {
                setCategoryId(event.currentTarget.value);
              }}
              data-testid="shopping-quick-add-category"
            />
          ) : null}
        </div>
      ) : null}
      {duplicate !== null ? (
        <FormAlert tone="info" announce>
          <span className="flex flex-col gap-2">
            <span>{t("duplicateQuestion", { name: duplicate })}</span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  submit(true);
                }}
                data-testid="shopping-add-anyway"
              >
                {t("addAnyway")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDuplicate(null);
                  input.current?.focus();
                }}
              >
                {t("cancel")}
              </Button>
            </span>
          </span>
        </FormAlert>
      ) : null}
      {add.error ? (
        <FormAlert tone="error" announce>
          {failure(add.error.failure)}
          {add.error.failure === "network" ? ` ${t("tryAgainHint")}` : null}
        </FormAlert>
      ) : null}
    </form>
  );
}
