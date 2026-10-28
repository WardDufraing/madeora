"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useToast } from "@/components/ui/toast";
import {
  sendShoppingRequest,
  shoppingItemEndpoint,
  shoppingListEndpoint,
  type ShoppingItem,
  type ShoppingListDetail,
  type ShoppingRequestError,
  type ShoppingTransferAnswer,
} from "@/shopping/api";
import { shoppingKeys } from "@/shopping/format";

import { useShoppingFailure } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

type Mode = "move" | "copy";

interface TransferInput {
  readonly allowDuplicate: boolean;
}

function listUrl(listId: string, homeId: string | null) {
  return homeId
    ? `${shoppingListEndpoint(listId)}?homeId=${encodeURIComponent(homeId)}`
    : shoppingListEndpoint(listId);
}

/**
 * Move or copy an item to another active list of the same context (S26). Shows the destinations
 * the viewer may add to, the destination's categories (default Uncategorized), what happens to the
 * source and, for a completed item, Keep completed or Reopen. Everything is checked again at
 * confirmation; a clear duplicate in the destination asks first. A move offers Undo.
 */
export function ItemTransfer({
  item,
  list,
  homeId,
  onDone,
  onCancel,
}: {
  readonly item: ShoppingItem;
  readonly list: ShoppingListDetail;
  readonly homeId: string | null;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("move");
  const [destinationId, setDestinationId] = useState(list.destinations[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [keepCompleted, setKeepCompleted] = useState(true);
  const [duplicate, setDuplicate] = useState(false);
  const [copyId] = useState(() => crypto.randomUUID());
  const formId = useId();
  const destination = list.destinations.find((candidate) => candidate.id === destinationId);

  const categories = useQuery<ShoppingListDetail, ShoppingRequestError>({
    queryKey: [...shoppingKeys.all, "destination", destinationId],
    queryFn: () => sendShoppingRequest("GET", listUrl(destinationId, homeId)),
    enabled: destinationId !== "",
    retry: false,
  });

  // Moves it back with the same checks: the item's current revision is read from where it went.
  const undoMove = async () => {
    try {
      const moved = await sendShoppingRequest<ShoppingListDetail>(
        "GET",
        listUrl(destinationId, homeId),
      );
      const current = moved.items.find((candidate) => candidate.id === item.id);
      if (!current) throw new Error("gone");
      await sendShoppingRequest<ShoppingTransferAnswer>(
        "POST",
        shoppingItemEndpoint(item.id, "transfer"),
        {
          mode: "move",
          destinationListId: list.id,
          revision: current.revision,
          categoryId: item.categoryId,
          keepCompleted: true,
          allowDuplicate: true,
          copyId: null,
        },
      );
      toast.show({ title: t("moveUndone", { name: item.name }), tone: "success" });
    } catch {
      toast.show({ title: t("moveNotUndone"), tone: "error" });
    }
  };

  const transfer = useShoppingMutation(
    `shopping-item:${item.id}`,
    ({ allowDuplicate }: TransferInput) =>
      sendShoppingRequest<ShoppingTransferAnswer>(
        "POST",
        shoppingItemEndpoint(item.id, "transfer"),
        {
          mode,
          destinationListId: destinationId,
          revision: item.revision,
          categoryId: categoryId === "" ? null : categoryId,
          keepCompleted,
          allowDuplicate,
          copyId: mode === "copy" ? copyId : null,
        },
      ),
    () => {
      const name = destination?.name ?? "";
      onDone();
      toast.show({
        title:
          mode === "move"
            ? t("movedTo", { name: item.name, list: name })
            : t("copiedTo", { name: item.name, list: name }),
        tone: "success",
        ...(mode === "move"
          ? {
              action: {
                label: t("undo"),
                onAction: () => {
                  void undoMove();
                },
              },
            }
          : {}),
      });
    },
  );

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setDuplicate(false);
        transfer.mutate(
          { allowDuplicate: false },
          {
            onError: (error) => {
              if (error.failure === "duplicate") setDuplicate(true);
            },
          },
        );
      }}
      data-testid="shopping-transfer"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-fg">{t("transferMode")}</legend>
        {(["move", "copy"] as const).map((value) => (
          <div key={value} className="flex items-start gap-2">
            <input
              id={`${formId}-${value}`}
              type="radio"
              name="mode"
              value={value}
              checked={mode === value}
              aria-describedby={`${formId}-${value}-hint`}
              className="mt-1 size-4 accent-accent"
              onChange={() => {
                setMode(value);
              }}
            />
            <span className="flex flex-col">
              <label htmlFor={`${formId}-${value}`} className="text-body text-fg">
                {value === "move" ? t("transferMove") : t("transferCopy")}
              </label>
              <span id={`${formId}-${value}-hint`} className="text-helper text-fg-muted">
                {value === "move" ? t("transferMoveHint") : t("transferCopyHint")}
              </span>
            </span>
          </div>
        ))}
      </fieldset>
      <SelectField
        label={t("transferDestination")}
        value={destinationId}
        options={list.destinations.map((candidate) => ({
          value: candidate.id,
          label: list.destinations.some(
            (other) => other.id !== candidate.id && other.name === candidate.name,
          )
            ? t("destinationWithPosition", {
                name: candidate.name,
                position: candidate.position + 1,
              })
            : candidate.name,
        }))}
        onChange={(event) => {
          setDestinationId(event.currentTarget.value);
          setCategoryId("");
          setDuplicate(false);
        }}
        data-testid="shopping-transfer-destination"
      />
      <SelectField
        label={t("transferCategory")}
        value={categoryId}
        disabled={!categories.data}
        options={[
          { value: "", label: t("uncategorized") },
          ...(categories.data?.categories ?? []).map((category) => ({
            value: category.id,
            label: category.name,
          })),
        ]}
        onChange={(event) => {
          setCategoryId(event.currentTarget.value);
        }}
      />
      {item.completedAt !== null ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium text-fg">{t("transferCompletion")}</legend>
          {[true, false].map((keep) => (
            <label key={String(keep)} className="flex items-center gap-2 text-body text-fg">
              <input
                type="radio"
                name="keepCompleted"
                checked={keepCompleted === keep}
                className="size-4 accent-accent"
                onChange={() => {
                  setKeepCompleted(keep);
                }}
              />
              {keep ? t("transferKeepCompleted") : t("transferReopen")}
            </label>
          ))}
        </fieldset>
      ) : null}
      {item.recurrenceId !== null && mode === "move" ? (
        <p className="text-helper text-fg-muted">{t("transferDetachesRule")}</p>
      ) : null}
      {duplicate ? (
        <FormAlert tone="info" announce>
          <span className="flex flex-col gap-2">
            <span>
              {t("transferDuplicate", { name: item.name, list: destination?.name ?? "" })}
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={transfer.busy}
                onClick={() => {
                  transfer.mutate({ allowDuplicate: true });
                }}
                data-testid="shopping-transfer-anyway"
              >
                {t("addAsSeparate")}
              </Button>
              <Button size="sm" variant="secondary" onClick={onCancel}>
                {t("cancel")}
              </Button>
            </span>
          </span>
        </FormAlert>
      ) : transfer.error ? (
        <FormAlert tone="error" announce>
          {transfer.error.failure === "conflict"
            ? t("itemChangedMeanwhile")
            : failure(transfer.error.failure)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          loading={transfer.busy}
          disabled={destinationId === "" || duplicate}
          data-testid="shopping-transfer-confirm"
        >
          {mode === "move" ? t("transferMoveConfirm") : t("transferCopyConfirm")}
        </Button>
      </div>
    </form>
  );
}
