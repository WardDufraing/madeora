"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { parseShoppingQuantity, shoppingUnits } from "@madeora/domain/shopping";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import {
  sendShoppingRequest,
  shoppingItemEndpoint,
  type ShoppingHistoryEntry,
  type ShoppingItem,
  type ShoppingListDetail,
  type ShoppingRequestError,
} from "@/shopping/api";
import { quantityInput, shoppingKeys, type ShoppingRights } from "@/shopping/format";
import { itemNameSchema, notesSchema, packagingSchema, unitSchema } from "@/shopping/schema";
import type { MemberNames } from "@/tasks/format";
import { TRASH_RESTORE_ENDPOINT, type RestoreResponse } from "@/trash/api";

import { useFieldMessage } from "./field-message";
import { ItemRepeat } from "./item-repeat";
import { ItemTransfer } from "./item-transfer";
import { useShoppingFailure, useShoppingTexts } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

/** Optional text: blank is none, anything else must pass `schema`. */
function optionalText<S extends z.ZodType<string, string>>(schema: S) {
  return z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(schema.nullable());
}

const itemForm = z
  .strictObject({
    name: itemNameSchema,
    quantity: z.string().transform((value, context) => {
      if (value.trim() === "") return null;
      const quantity = parseShoppingQuantity(value);
      if (quantity === null) {
        context.addIssue({ code: "custom", message: "invalidQuantity" });
        return z.NEVER;
      }
      return quantity;
    }),
    unit: z.union([z.literal(""), unitSchema]).transform((value) => (value === "" ? null : value)),
    packaging: optionalText(packagingSchema),
    notes: optionalText(notesSchema),
    categoryId: z.string().transform((value) => (value === "" ? null : value)),
  })
  .refine((item) => item.unit === null || item.quantity !== null, {
    error: "unitNeedsQuantity",
    path: ["unit"],
  });
type ItemInput = z.input<typeof itemForm>;
type ItemOutput = z.output<typeof itemForm>;

export interface ItemEditorProps {
  readonly item: ShoppingItem;
  readonly list: ShoppingListDetail;
  readonly rights: ShoppingRights;
  readonly names: MemberNames;
  readonly formats: DateTimeFormats;
  readonly today: string;
  readonly homeId: string | null;
  readonly onClose: () => void;
}

/**
 * An item's dialog (S26): its details and category (editors; revision-checked, so someone else's
 * newer edit is never overwritten), Repeat, Move or copy, Delete (to the trash, with Undo) and its
 * history. Viewers who may not edit see the details and history only.
 */
export function ItemEditor({
  item,
  list,
  rights,
  names,
  formats,
  today,
  homeId,
  onClose,
}: ItemEditorProps) {
  const t = useTranslations("Shopping");
  const locale = useLocale();
  const failure = useShoppingFailure();
  const message = useFieldMessage();
  const texts = useShoppingTexts(names);
  const toast = useToast();
  const [panel, setPanel] = useState<"details" | "transfer" | "delete">("details");
  const editable = rights.edit;
  const form = useForm<ItemInput, unknown, ItemOutput>({
    resolver: zodResolver(itemForm),
    defaultValues: {
      name: item.name,
      quantity: quantityInput(item.quantity, locale),
      unit: item.unit ?? "",
      packaging: item.packaging ?? "",
      notes: item.notes ?? "",
      categoryId: item.categoryId ?? "",
    },
  });
  const errors = form.formState.errors;
  const save = useShoppingMutation(
    `shopping-item:${item.id}`,
    (values: ItemOutput) =>
      sendShoppingRequest<object>("PATCH", shoppingItemEndpoint(item.id), {
        revision: item.revision,
        ...values,
      }),
    onClose,
  );
  const restore = async (entryId: string) => {
    try {
      const answer = await sendShoppingRequest<RestoreResponse>("POST", TRASH_RESTORE_ENDPOINT, {
        entryIds: [entryId],
      });
      const restored = answer.results[0]?.outcome === "restored";
      toast.show({
        title: restored ? t("itemRestored", { name: item.name }) : t("itemNotRestored"),
        tone: restored ? "success" : "error",
      });
    } catch {
      toast.show({ title: t("itemNotRestored"), tone: "error" });
    }
    // The page re-reads on its own: restoring bumps the list's signal.
  };
  const remove = useShoppingMutation(
    `shopping-item:${item.id}`,
    () =>
      sendShoppingRequest<{ entryId: string | null }>("DELETE", shoppingItemEndpoint(item.id), {}),
    ({ entryId }) => {
      onClose();
      toast.show({
        title: t("itemDeleted", { name: item.name }),
        tone: "success",
        ...(entryId
          ? {
              action: {
                label: t("undo"),
                onAction: () => {
                  void restore(entryId);
                },
              },
            }
          : {}),
      });
    },
  );

  const title = editable ? t("editItemTitle") : t("itemTitle");
  return (
    <Dialog open onClose={onClose} title={title} closeLabel={t("close")}>
      <div className="flex flex-col gap-5" data-testid="shopping-item-editor">
        {panel === "transfer" ? (
          <ItemTransfer
            item={item}
            list={list}
            homeId={homeId}
            onDone={onClose}
            onCancel={() => {
              setPanel("details");
            }}
          />
        ) : panel === "delete" ? (
          <div className="flex flex-col gap-3">
            <p className="text-body text-fg">{t("deleteItemQuestion", { name: item.name })}</p>
            <p className="text-helper text-fg-muted">{t("deleteItemTrash")}</p>
            {remove.error ? (
              <FormAlert tone="error" announce>
                {failure(remove.error.failure)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setPanel("details");
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                loading={remove.busy}
                onClick={() => {
                  remove.mutate(undefined);
                }}
                data-testid="shopping-item-delete-confirm"
              >
                {t("deleteItem")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {editable ? (
              <form
                noValidate
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  void form.handleSubmit((values) => {
                    save.mutate(values);
                  })(event);
                }}
              >
                <TextField
                  label={t("fieldName")}
                  autoComplete="off"
                  error={message(errors.name?.message)}
                  data-testid="shopping-item-name"
                  {...form.register("name")}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label={t("fieldQuantity")}
                    description={t("fieldQuantityHint")}
                    inputMode="decimal"
                    autoComplete="off"
                    error={message(errors.quantity?.message)}
                    data-testid="shopping-item-quantity"
                    {...form.register("quantity")}
                  />
                  <SelectField
                    label={t("fieldUnit")}
                    options={[
                      { value: "", label: t("unitNone") },
                      ...shoppingUnits.map((unit) => ({ value: unit, label: texts.unit(unit) })),
                    ]}
                    data-testid="shopping-item-unit"
                    {...form.register("unit")}
                  />
                </div>
                {errors.unit?.message ? (
                  <FormAlert tone="error">{message(errors.unit.message)}</FormAlert>
                ) : null}
                <TextField
                  label={t("fieldPackaging")}
                  description={t("fieldPackagingHint")}
                  autoComplete="off"
                  error={message(errors.packaging?.message)}
                  {...form.register("packaging")}
                />
                <TextArea
                  label={t("fieldNotes")}
                  rows={2}
                  error={message(errors.notes?.message)}
                  {...form.register("notes")}
                />
                <SelectField
                  label={t("fieldCategory")}
                  options={[
                    { value: "", label: t("uncategorized") },
                    ...list.categories.map((category) => ({
                      value: category.id,
                      label: category.name,
                    })),
                  ]}
                  data-testid="shopping-item-category"
                  {...form.register("categoryId")}
                />
                {save.error ? (
                  <FormAlert tone="error" announce>
                    {save.error.failure === "conflict"
                      ? t("itemChangedMeanwhile")
                      : failure(save.error.failure)}
                  </FormAlert>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="submit" loading={save.busy} data-testid="shopping-item-save">
                    {t("save")}
                  </Button>
                </div>
              </form>
            ) : (
              <ItemFacts item={item} list={list} amount={texts.amount(item.quantity, item.unit)} />
            )}
            {rights.edit ? (
              <ItemRepeat item={item} list={list} formats={formats} today={today} />
            ) : null}
            {rights.edit ? (
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {list.destinations.length > 0 ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPanel("transfer");
                    }}
                    data-testid="shopping-item-transfer"
                  >
                    {t("moveOrCopy")}
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => {
                    remove.reset();
                    setPanel("delete");
                  }}
                  data-testid="shopping-item-delete"
                >
                  {t("deleteItem")}
                </Button>
              </div>
            ) : null}
            <ItemHistory item={item} names={names} formats={formats} />
          </>
        )}
      </div>
    </Dialog>
  );
}

function ItemFacts({
  item,
  list,
  amount,
}: {
  readonly item: ShoppingItem;
  readonly list: ShoppingListDetail;
  readonly amount: string | null;
}) {
  const t = useTranslations("Shopping");
  const category = list.categories.find((candidate) => candidate.id === item.categoryId);
  return (
    <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_1fr]">
      <dt className="font-medium text-fg">{t("fieldName")}</dt>
      <dd className="text-fg">
        <bdi>{item.name}</bdi>
      </dd>
      {amount ? (
        <>
          <dt className="font-medium text-fg">{t("fieldQuantity")}</dt>
          <dd className="text-fg">{amount}</dd>
        </>
      ) : null}
      {item.packaging ? (
        <>
          <dt className="font-medium text-fg">{t("fieldPackaging")}</dt>
          <dd className="text-fg">
            <bdi>{item.packaging}</bdi>
          </dd>
        </>
      ) : null}
      {item.notes ? (
        <>
          <dt className="font-medium text-fg">{t("fieldNotes")}</dt>
          <dd className="whitespace-pre-line text-fg">{item.notes}</dd>
        </>
      ) : null}
      <dt className="font-medium text-fg">{t("fieldCategory")}</dt>
      <dd className="text-fg">
        <bdi>{category?.name ?? t("uncategorized")}</bdi>
      </dd>
    </dl>
  );
}

const historyKey = {
  added: "history_added",
  edited: "history_edited",
  completed: "history_completed",
  reopened: "history_reopened",
  moved_in: "history_moved_in",
  moved_out: "history_moved_out",
  copied: "history_copied",
  recurred: "history_recurred",
  deleted: "history_deleted",
  cleared: "history_cleared",
  restored: "history_restored",
} as const satisfies Record<ShoppingHistoryEntry["kind"], string>;

/** The item's latest 20 changes, read when asked for (who and when, never content). */
function ItemHistory({
  item,
  names,
  formats,
}: {
  readonly item: ShoppingItem;
  readonly names: MemberNames;
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Shopping");
  const texts = useShoppingTexts(names);
  const [open, setOpen] = useState(false);
  const history = useQuery<{ entries: readonly ShoppingHistoryEntry[] }, ShoppingRequestError>({
    queryKey: [...shoppingKeys.all, "history", item.id, item.revision],
    queryFn: () => sendShoppingRequest("GET", shoppingItemEndpoint(item.id, "history")),
    enabled: open,
    retry: false,
  });
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4" aria-label={t("history")}>
      {!open ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
            data-testid="shopping-item-history"
          >
            {t("showHistory")}
          </Button>
        </div>
      ) : history.isPending ? (
        <p className="text-helper text-fg-muted">{t("historyLoading")}</p>
      ) : history.error ? (
        <FormAlert tone="error" announce>
          {t("historyFailed")}
        </FormAlert>
      ) : (
        <ol
          className="flex flex-col gap-1 text-helper text-fg-muted"
          data-testid="shopping-history"
        >
          {history.data.entries.map((entry, index) => (
            // Two entries may share kind and time; their order is their identity.
            <li key={index}>
              {t(historyKey[entry.kind], {
                person: texts.person(entry.actor),
                list: entry.otherListName ?? t("anotherList"),
              })}{" "}
              {"\u{00B7}"} {formatDateTime(entry.at, formats)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
