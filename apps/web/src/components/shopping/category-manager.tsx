"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { SHOPPING_LIMITS } from "@madeora/domain/shopping";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  sendShoppingRequest,
  shoppingCategoryEndpoint,
  shoppingListEndpoint,
  type ShoppingCategory,
  type ShoppingListDetail,
} from "@/shopping/api";
import { categoryNameSchema } from "@/shopping/schema";

import { useFieldMessage } from "./field-message";
import { useShoppingFailure } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

const categoryForm = z.strictObject({ name: categoryNameSchema });
type CategoryInput = z.input<typeof categoryForm>;
type CategoryOutput = z.output<typeof categoryForm>;

/**
 * A list's categories (S26; its editors): add, rename, reorder one place at a time, remove. Names
 * are distinct within the list, ignoring case and accents; nothing is suggested or created
 * automatically. Removing one says how many items it holds and moves them to Uncategorized.
 */
export function CategoryManager({ list }: { readonly list: ShoppingListDetail }) {
  const t = useTranslations("Shopping");
  const [open, setOpen] = useState(false);
  const { announce, region } = useAnnouncer();
  return (
    <>
      {region}
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="shopping-categories"
      >
        {t("categories")}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t("categoriesTitle")}
        description={t("categoriesDescription")}
        closeLabel={t("close")}
      >
        <div className="flex flex-col gap-4">
          {list.categories.length === 0 ? (
            <p className="text-body text-fg-muted">{t("noCategories")}</p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="shopping-category-list">
              {list.categories.map((category, index) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  count={list.items.filter((item) => item.categoryId === category.id).length}
                  first={index === 0}
                  last={index === list.categories.length - 1}
                  announce={announce}
                />
              ))}
            </ul>
          )}
          {list.categories.length < SHOPPING_LIMITS.categories ? (
            <AddCategory listId={list.id} announce={announce} />
          ) : (
            <FormAlert tone="info">{t("categoriesFull")}</FormAlert>
          )}
        </div>
      </Dialog>
    </>
  );
}

function AddCategory({
  listId,
  announce,
}: {
  readonly listId: string;
  readonly announce: (message: string) => void;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const message = useFieldMessage();
  const [categoryId, setCategoryId] = useState(() => crypto.randomUUID());
  const form = useForm<CategoryInput, unknown, CategoryOutput>({
    resolver: zodResolver(categoryForm),
    defaultValues: { name: "" },
  });
  const create = useShoppingMutation(
    `shopping-category:${categoryId}`,
    (name: string) =>
      sendShoppingRequest<object>("POST", shoppingListEndpoint(listId, "categories"), {
        id: categoryId,
        name,
      }),
    (_output, name) => {
      announce(t("announceCategoryAdded", { name }));
      form.reset({ name: "" });
      setCategoryId(crypto.randomUUID());
    },
  );
  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          create.mutate(values.name);
        })(event);
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label={t("fieldCategoryName")}
          className="min-w-0 flex-1"
          autoComplete="off"
          error={message(form.formState.errors.name?.message)}
          data-testid="shopping-category-name"
          {...form.register("name")}
        />
        <Button type="submit" loading={create.busy} data-testid="shopping-category-add">
          {t("addCategory")}
        </Button>
      </div>
      {create.error ? (
        <FormAlert tone="error" announce>
          {failure(create.error.failure)}
        </FormAlert>
      ) : null}
    </form>
  );
}

function CategoryRow({
  category,
  count,
  first,
  last,
  announce,
}: {
  readonly category: ShoppingCategory;
  readonly count: number;
  readonly first: boolean;
  readonly last: boolean;
  readonly announce: (message: string) => void;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const message = useFieldMessage();
  const [mode, setMode] = useState<"view" | "rename" | "remove">("view");
  const form = useForm<CategoryInput, unknown, CategoryOutput>({
    resolver: zodResolver(categoryForm),
    defaultValues: { name: category.name },
  });
  const endpoint = shoppingCategoryEndpoint(category.id);
  const scope = `shopping-category:${category.id}`;
  const rename = useShoppingMutation(
    scope,
    (name: string) =>
      sendShoppingRequest<object>("PATCH", endpoint, { revision: category.revision, name }),
    () => {
      setMode("view");
    },
  );
  const move = useShoppingMutation(scope, (direction: "up" | "down") =>
    sendShoppingRequest<object>("PATCH", endpoint, { direction }),
  );
  const remove = useShoppingMutation(
    scope,
    () =>
      sendShoppingRequest<{ movedItems: number }>("DELETE", endpoint, {
        revision: category.revision,
      }),
    ({ movedItems }) => {
      announce(t("announceCategoryRemoved", { name: category.name, count: movedItems }));
    },
  );
  const error = rename.error ?? move.error ?? remove.error;

  return (
    <li
      className="flex flex-col gap-2 rounded-control border border-line p-3"
      data-testid="shopping-category"
    >
      {mode === "rename" ? (
        <form
          noValidate
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              rename.mutate(values.name);
            })(event);
          }}
        >
          <TextField
            label={t("fieldCategoryName")}
            className="min-w-0 flex-1"
            autoComplete="off"
            error={message(form.formState.errors.name?.message)}
            {...form.register("name")}
          />
          <Button type="submit" size="sm" loading={rename.busy}>
            {t("save")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setMode("view");
            }}
          >
            {t("cancel")}
          </Button>
        </form>
      ) : mode === "remove" ? (
        <div className="flex flex-col gap-2">
          <p className="text-body text-fg">
            {t("removeCategoryQuestion", { name: category.name, count })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              loading={remove.busy}
              onClick={() => {
                remove.mutate(undefined);
              }}
              data-testid="shopping-category-remove-confirm"
            >
              {t("removeCategory")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setMode("view");
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-body text-fg">
            <bdi>{category.name}</bdi>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={first || move.busy}
            aria-label={t("moveCategoryUp", { name: category.name })}
            onClick={() => {
              move.mutate("up");
            }}
          >
            {t("moveUp")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={last || move.busy}
            aria-label={t("moveCategoryDown", { name: category.name })}
            onClick={() => {
              move.mutate("down");
            }}
          >
            {t("moveDown")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("renameCategory", { name: category.name })}
            onClick={() => {
              rename.reset();
              form.reset({ name: category.name });
              setMode("rename");
            }}
          >
            {t("rename")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("removeCategoryNamed", { name: category.name })}
            onClick={() => {
              remove.reset();
              setMode("remove");
            }}
            data-testid="shopping-category-remove"
          >
            {t("removeCategory")}
          </Button>
        </div>
      )}
      {error ? (
        <FormAlert tone="error" announce>
          {error.failure === "conflict" ? t("categoryChangedMeanwhile") : failure(error.failure)}
        </FormAlert>
      ) : null}
    </li>
  );
}
