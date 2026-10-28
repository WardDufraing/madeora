"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { SHOPPING_LISTS_ENDPOINT, sendShoppingRequest, shoppingListEndpoint } from "@/shopping/api";
import { shoppingListPath } from "@/shopping/format";
import { listNameSchema } from "@/shopping/schema";

import { useFieldMessage } from "./field-message";
import { useShoppingFailure } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

const nameForm = z.strictObject({ name: listNameSchema });
type NameInput = z.input<typeof nameForm>;
type NameOutput = z.output<typeof nameForm>;

/** New list: a name (1–60 visible characters; names may repeat), then the new list opens. */
export function NewListButton({ homeId }: { readonly homeId: string | null }) {
  const t = useTranslations("Shopping");
  const router = useRouter();
  const failure = useShoppingFailure();
  const message = useFieldMessage();
  const [open, setOpen] = useState(false);
  // One id per dialog: a retry after a lost answer finds the list instead of making a second one.
  const [listId, setListId] = useState(() => crypto.randomUUID());
  const form = useForm<NameInput, unknown, NameOutput>({
    resolver: zodResolver(nameForm),
    defaultValues: { name: "" },
  });
  const create = useShoppingMutation(
    `shopping-list:${listId}`,
    (name: string) =>
      sendShoppingRequest<{ id: string }>("POST", SHOPPING_LISTS_ENDPOINT, {
        id: listId,
        name,
        homeId,
      }),
    () => {
      setOpen(false);
      router.push(shoppingListPath(homeId, listId));
    },
  );
  return (
    <HydrationGate>
      <Button
        onClick={() => {
          create.reset();
          form.reset({ name: "" });
          setListId(crypto.randomUUID());
          setOpen(true);
        }}
        data-testid="new-shopping-list"
      >
        {t("newList")}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t("newListTitle")}
        closeLabel={t("close")}
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              create.mutate(values.name);
            })(event);
          }}
        >
          <TextField
            label={t("fieldListName")}
            autoComplete="off"
            error={message(form.formState.errors.name?.message)}
            data-testid="shopping-list-name"
            {...form.register("name")}
          />
          {create.error ? (
            <FormAlert tone="error" announce>
              {failure(create.error.failure)}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" loading={create.busy} data-testid="shopping-list-create">
              {t("createList")}
            </Button>
          </div>
        </form>
      </Dialog>
    </HydrationGate>
  );
}

/** Move up / Move down for a context's list (its shopping managers): one place at a time. */
export function ListMoveButtons({
  listId,
  name,
  first,
  last,
}: {
  readonly listId: string;
  readonly name: string;
  readonly first: boolean;
  readonly last: boolean;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const { announce, region } = useAnnouncer();
  const move = useShoppingMutation(
    `shopping-list:${listId}`,
    (direction: "up" | "down") =>
      sendShoppingRequest<object>("POST", shoppingListEndpoint(listId, "move"), { direction }),
    (_output, direction) => {
      announce(
        direction === "up" ? t("announceMovedUp", { name }) : t("announceMovedDown", { name }),
      );
    },
  );
  return (
    <HydrationGate>
      {region}
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={first || move.busy}
          aria-label={t("moveListUp", { name })}
          onClick={() => {
            move.mutate("up");
          }}
        >
          {t("moveUp")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={last || move.busy}
          aria-label={t("moveListDown", { name })}
          onClick={() => {
            move.mutate("down");
          }}
        >
          {t("moveDown")}
        </Button>
      </div>
      {move.error ? (
        <FormAlert tone="error" announce className="w-full">
          {failure(move.error.failure)}
        </FormAlert>
      ) : null}
    </HydrationGate>
  );
}
