"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import {
  sendShoppingRequest,
  ShoppingRequestError,
  shoppingListEndpoint,
  type ShoppingAddResult,
} from "@/shopping/api";
import { itemNameSchema } from "@/shopping/schema";

import { useFieldMessage } from "./field-message";
import { useShoppingFailure } from "./use-shopping-texts";
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
  onAdded,
}: {
  readonly listId: string;
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

  const add = useShoppingMutation(
    `shopping-add:${listId}`,
    async ({ value, allowDuplicate }: { value: string; allowDuplicate: boolean }) => {
      const [result] = await addShoppingItems(listId, [
        { id: itemId, name: value, allowDuplicate },
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
    add.mutate({ value: parsed.data, allowDuplicate });
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
