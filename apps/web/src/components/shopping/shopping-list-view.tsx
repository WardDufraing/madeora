"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import {
  sendShoppingRequest,
  shoppingItemEndpoint,
  shoppingListEndpoint,
  type ShoppingClearAnswer,
  type ShoppingCompletionAnswer,
  type ShoppingItem,
  type ShoppingListDetail,
} from "@/shopping/api";
import { shoppingListPath, shoppingRights, type ShoppingRights } from "@/shopping/format";
import { memberNames, type MemberOption } from "@/tasks/format";

import { CategoryManager } from "./category-manager";
import { ItemEditor } from "./item-editor";
import { ListSettings } from "./list-settings";
import { QuickAdd } from "./quick-add";
import { useShoppingFailure, useShoppingTexts } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

const noPending: ReadonlyMap<string, boolean> = new Map();

export interface ShoppingListViewProps {
  readonly list: ShoppingListDetail;
  readonly homeId: string | null;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  /** Today in the list's context (YYYY-MM-DD), for schedule previews. */
  readonly today: string;
}

/**
 * A list's interactive page (S26). Checking an item moves it to Completed at once (the change is
 * shown while it is being saved and taken back if refused); everything else re-reads the list
 * after each change, and the page is live, so what shows is the database's state.
 */
export function ShoppingListView({ list, homeId, members, formats, today }: ShoppingListViewProps) {
  const t = useTranslations("Shopping");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useShoppingTexts(names);
  const rights = shoppingRights(list);
  const { announce, region } = useAnnouncer();
  const [editing, setEditing] = useState<string | null>(null);
  // Checked or unchecked here and not yet re-read: shown in its new place meanwhile. Kept with
  // the list it was made on, so a fresh read (a new `list`) drops it.
  const [pendingState, setPendingState] = useState<{
    readonly list: ShoppingListDetail;
    readonly map: ReadonlyMap<string, boolean>;
  }>({ list, map: new Map() });
  const pending = pendingState.list === list ? pendingState.map : noPending;
  const setPending = (update: (current: ReadonlyMap<string, boolean>) => Map<string, boolean>) => {
    setPendingState((current) => ({
      list,
      map: update(current.list === list ? current.map : noPending),
    }));
  };

  const isCompleted = (item: ShoppingItem) => pending.get(item.id) ?? item.completedAt !== null;
  const active = list.items.filter((item) => !isCompleted(item));
  const completed = list.items
    .filter(isCompleted)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  const groups = [
    ...list.categories.map((category) => ({
      id: category.id,
      name: category.name,
      items: active.filter((item) => item.categoryId === category.id),
    })),
    { id: null, name: t("uncategorized"), items: active.filter((item) => !item.categoryId) },
  ].filter((group) => group.items.length > 0);
  const editingItem = list.items.find((item) => item.id === editing) ?? null;
  const rules = new Map(list.recurrences.map((rule) => [rule.id, rule]));

  const toggle = (item: ShoppingItem, next: boolean) => {
    setPending((current) => new Map(current).set(item.id, next));
  };
  const untoggle = (item: ShoppingItem) => {
    setPending((current) => {
      const copy = new Map(current);
      copy.delete(item.id);
      return copy;
    });
  };

  return (
    <HydrationGate>
      {region}
      <div className="flex flex-col gap-6" data-testid="shopping-list">
        {list.archived ? (
          <FormAlert tone="info">{t("archivedNotice")}</FormAlert>
        ) : list.access === "view" ? (
          <FormAlert tone="info">{t("viewOnlyNotice")}</FormAlert>
        ) : list.access === "check" ? (
          <FormAlert tone="info">{t("checkOnlyNotice")}</FormAlert>
        ) : null}
        {rights.edit ? (
          <div className="flex flex-col gap-2">
            <QuickAdd
              listId={list.id}
              onAdded={(name) => {
                announce(t("announceAdded", { name }));
              }}
            />
            <p className="flex flex-wrap gap-3">
              <Link
                href={shoppingListPath(homeId, list.id, "add-several")}
                className="text-body font-medium text-accent-fg underline"
                data-testid="shopping-add-several"
              >
                {t("addSeveral")}
              </Link>
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {rights.edit ? <CategoryManager list={list} /> : null}
          {rights.manage ? <ListSettings list={list} homeId={homeId} /> : null}
        </div>

        <section aria-labelledby="shopping-active-heading" className="flex flex-col gap-4">
          <h2 id="shopping-active-heading" className="text-section-title font-semibold text-fg">
            {t("activeHeading", { count: active.length })}
          </h2>
          {active.length === 0 ? (
            <p className="text-body text-fg-muted" data-testid="shopping-active-empty">
              {list.items.length === 0 ? t("listEmpty") : t("allDone")}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.id ?? "uncategorized"} className="flex flex-col gap-2">
                {list.categories.length > 0 ? (
                  <h3 className="text-body font-semibold text-fg-muted">
                    <bdi>{group.name}</bdi>
                  </h3>
                ) : null}
                <ul className="flex flex-col gap-1" data-testid="shopping-active-items">
                  {group.items.map((item, index) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      rights={rights}
                      first={index === 0}
                      last={index === group.items.length - 1}
                      repeats={item.recurrenceId !== null && rules.has(item.recurrenceId)}
                      amount={texts.amount(item.quantity, item.unit)}
                      onToggle={toggle}
                      onRevert={untoggle}
                      onEdit={() => {
                        setEditing(item.id);
                      }}
                      announce={announce}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>

        <CompletedSection
          list={list}
          items={completed}
          rights={rights}
          person={texts.person}
          amount={texts.amount}
          formats={formats}
          onToggle={toggle}
          onRevert={untoggle}
          onEdit={setEditing}
          announce={announce}
        />
      </div>
      {editingItem ? (
        <ItemEditor
          key={editingItem.id}
          item={editingItem}
          list={list}
          rights={rights}
          names={names}
          formats={formats}
          today={today}
          homeId={homeId}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
    </HydrationGate>
  );
}

function ItemRow({
  item,
  rights,
  first,
  last,
  repeats,
  amount,
  onToggle,
  onRevert,
  onEdit,
  announce,
}: {
  readonly item: ShoppingItem;
  readonly rights: ShoppingRights;
  readonly first: boolean;
  readonly last: boolean;
  readonly repeats: boolean;
  readonly amount: string | null;
  readonly onToggle: (item: ShoppingItem, completed: boolean) => void;
  readonly onRevert: (item: ShoppingItem) => void;
  readonly onEdit: () => void;
  readonly announce: (message: string) => void;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const complete = useCompletion(item, onToggle, onRevert, announce);
  const move = useShoppingMutation(`shopping-item:${item.id}`, (direction: "up" | "down") =>
    sendShoppingRequest<object>("POST", shoppingItemEndpoint(item.id, "move"), { direction }),
  );
  const error = complete.error ?? move.error;
  return (
    <li
      className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-surface px-3 py-2"
      data-testid="shopping-item"
      data-item-name={item.name}
    >
      <input
        type="checkbox"
        className="size-5 shrink-0 accent-accent"
        checked={false}
        disabled={!rights.check || complete.busy}
        aria-label={t("checkItem", { name: item.name })}
        onChange={() => {
          complete.mutate(true);
        }}
        data-testid="shopping-item-check"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-fg">
          {amount ? <span className="font-semibold">{amount} </span> : null}
          <bdi>{item.name}</bdi>
          {item.packaging ? (
            <span className="text-fg-muted">
              {" "}
              (<bdi>{item.packaging}</bdi>)
            </span>
          ) : null}
        </span>
        {item.notes ? (
          <span className="whitespace-pre-line text-helper text-fg-muted">{item.notes}</span>
        ) : null}
        {repeats ? <span className="text-helper text-fg-muted">{t("repeatsBadge")}</span> : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {rights.edit ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={first || move.busy}
              aria-label={t("moveItemUp", { name: item.name })}
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
              aria-label={t("moveItemDown", { name: item.name })}
              onClick={() => {
                move.mutate("down");
              }}
            >
              {t("moveDown")}
            </Button>
          </>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          aria-label={
            rights.edit ? t("editItem", { name: item.name }) : t("itemDetails", { name: item.name })
          }
          onClick={onEdit}
          data-testid="shopping-item-edit"
        >
          {rights.edit ? t("edit") : t("details")}
        </Button>
      </div>
      {error ? (
        <FormAlert tone="error" announce className="w-full">
          {failure(error.failure)}
          {error.failure === "network" ? (
            <Button
              variant="secondary"
              size="sm"
              className="ms-2"
              onClick={() => {
                if (complete.error) complete.mutate(true);
              }}
            >
              {t("tryAgain")}
            </Button>
          ) : null}
        </FormAlert>
      ) : null}
    </li>
  );
}

/**
 * Check or uncheck (set-to-state): shown in its new place at once and taken back when refused. A
 * reopen sends the completion it saw, so someone else's newer completion is not undone.
 */
function useCompletion(
  item: ShoppingItem,
  onToggle: (item: ShoppingItem, completed: boolean) => void,
  onRevert: (item: ShoppingItem) => void,
  announce: (message: string) => void,
) {
  const t = useTranslations("Shopping");
  return useShoppingMutation(
    `shopping-item:${item.id}`,
    async (completed: boolean) => {
      onToggle(item, completed);
      try {
        return await sendShoppingRequest<ShoppingCompletionAnswer>(
          "PUT",
          shoppingItemEndpoint(item.id, "completion"),
          { completed, seenCompletedAt: completed ? null : item.completedAt },
        );
      } catch (error) {
        onRevert(item);
        throw error;
      }
    },
    (answer, completed) => {
      announce(
        answer.outcome === "unchanged"
          ? t("announceAlreadyDone", { name: item.name })
          : completed
            ? t("announceChecked", { name: item.name })
            : t("announceUnchecked", { name: item.name }),
      );
    },
  );
}

function CompletedSection({
  list,
  items,
  rights,
  person,
  amount,
  formats,
  onToggle,
  onRevert,
  onEdit,
  announce,
}: {
  readonly list: ShoppingListDetail;
  readonly items: readonly ShoppingItem[];
  readonly rights: ShoppingRights;
  readonly person: ReturnType<typeof useShoppingTexts>["person"];
  readonly amount: ReturnType<typeof useShoppingTexts>["amount"];
  readonly formats: DateTimeFormats;
  readonly onToggle: (item: ShoppingItem, completed: boolean) => void;
  readonly onRevert: (item: ShoppingItem) => void;
  readonly onEdit: (itemId: string) => void;
  readonly announce: (message: string) => void;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const [confirming, setConfirming] = useState(false);
  // The ids the confirmation showed: exactly those are cleared.
  const [seen, setSeen] = useState<readonly string[]>([]);
  const clear = useShoppingMutation(
    `shopping-list:${list.id}:clear`,
    (itemIds: readonly string[]) =>
      sendShoppingRequest<ShoppingClearAnswer>(
        "POST",
        shoppingListEndpoint(list.id, "clear-completed"),
        { itemIds },
      ),
    (answer) => {
      setConfirming(false);
      announce(
        answer.skipped > 0
          ? t("announceClearedSkipped", { count: answer.cleared, skipped: answer.skipped })
          : t("announceCleared", { count: answer.cleared }),
      );
    },
  );
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="shopping-completed-heading" className="flex flex-col gap-3">
      <details open className="flex flex-col gap-3" data-testid="shopping-completed">
        <summary className="cursor-pointer">
          <h2
            id="shopping-completed-heading"
            className="inline text-section-title font-semibold text-fg"
          >
            {t("completedHeading", { count: items.length })}
          </h2>
        </summary>
        <ul className="mt-3 flex flex-col gap-1" data-testid="shopping-completed-items">
          {items.map((item) => (
            <CompletedRow
              key={item.id}
              item={item}
              rights={rights}
              amount={amount(item.quantity, item.unit)}
              byline={
                item.completedAt
                  ? t("completedBy", {
                      person: person(item.completedBy),
                      time: formatDateTime(item.completedAt, formats),
                    })
                  : t("completedJustNow")
              }
              onToggle={onToggle}
              onRevert={onRevert}
              onEdit={() => {
                onEdit(item.id);
              }}
              announce={announce}
            />
          ))}
        </ul>
        {rights.edit ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              onClick={() => {
                clear.reset();
                setSeen(items.filter((item) => item.completedAt !== null).map((item) => item.id));
                setConfirming(true);
              }}
              data-testid="shopping-clear-completed"
            >
              {t("clearCompleted")}
            </Button>
          </div>
        ) : null}
      </details>
      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title={t("clearCompletedTitle", { count: seen.length })}
        description={t("clearCompletedBody")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={clear.busy}
              disabled={seen.length === 0}
              onClick={() => {
                clear.mutate(seen);
              }}
              data-testid="shopping-clear-confirm"
            >
              {t("clearCompletedConfirm", { count: seen.length })}
            </Button>
          </>
        }
      >
        {clear.error ? (
          <FormAlert tone="error" announce>
            {failure(clear.error.failure)}
          </FormAlert>
        ) : null}
      </Dialog>
    </section>
  );
}

function CompletedRow({
  item,
  rights,
  amount,
  byline,
  onToggle,
  onRevert,
  onEdit,
  announce,
}: {
  readonly item: ShoppingItem;
  readonly rights: ShoppingRights;
  readonly amount: string | null;
  readonly byline: string;
  readonly onToggle: (item: ShoppingItem, completed: boolean) => void;
  readonly onRevert: (item: ShoppingItem) => void;
  readonly onEdit: () => void;
  readonly announce: (message: string) => void;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const complete = useCompletion(item, onToggle, onRevert, announce);
  return (
    <li
      className="flex flex-wrap items-center gap-3 rounded-control px-3 py-2"
      data-testid="shopping-completed-item"
      data-item-name={item.name}
    >
      <input
        type="checkbox"
        className="size-5 shrink-0 accent-accent"
        checked
        disabled={!rights.check || complete.busy || item.completedAt === null}
        aria-label={t("uncheckItem", { name: item.name })}
        onChange={() => {
          complete.mutate(false);
        }}
        data-testid="shopping-item-uncheck"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-fg-muted line-through">
          {amount ? <span>{amount} </span> : null}
          <bdi>{item.name}</bdi>
        </span>
        <span className="text-helper text-fg-muted" data-testid="shopping-completed-by">
          {byline}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("itemDetails", { name: item.name })}
        onClick={onEdit}
      >
        {t("details")}
      </Button>
      {complete.error ? (
        <FormAlert tone="error" announce className="w-full">
          {complete.error.failure === "conflict"
            ? t("reopenConflict")
            : failure(complete.error.failure)}
        </FormAlert>
      ) : null}
    </li>
  );
}
