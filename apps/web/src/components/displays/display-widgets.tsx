"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import type { DisplayBoardChore, DisplayBoardList } from "@/displays/board";
import type { DisplayPreferences } from "@/displays/layout";
import { useShoppingTexts } from "@/components/shopping/use-shopping-texts";

function subscribeSeconds(onChange: () => void): () => void {
  const timer = setInterval(onChange, 1_000);
  return () => {
    clearInterval(timer);
  };
}
const secondNow = () => Math.floor(Date.now() / 1_000) * 1_000;

/** The current second on the client (null while rendering on the server). */
export function useSecond(): number | null {
  return useSyncExternalStore(subscribeSeconds, secondNow, () => null);
}

/**
 * The time (and date) in the Home's timezone, in the display's clock format (S44). Used by the
 * clock widget and by the lock and offline screens, which show nothing else.
 */
export function DisplayClock({
  timeZone,
  clockFormat,
  showDate = true,
  size = "large",
}: {
  readonly timeZone: string;
  readonly clockFormat: DisplayPreferences["clockFormat"];
  readonly showDate?: boolean;
  readonly size?: "large" | "medium";
}) {
  const locale = useLocale();
  const now = useSecond();
  const hour12 = clockFormat === "12h" ? true : clockFormat === "24h" ? false : undefined;
  const time =
    now === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          timeZone,
          ...(hour12 === undefined ? {} : { hour12 }),
        }).format(now);
  const date =
    now === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          weekday: "long",
          day: "numeric",
          month: "long",
          timeZone,
        }).format(now);
  return (
    <div className="flex flex-col items-center gap-2" data-testid="display-clock">
      <p
        className={
          size === "large"
            ? "font-mono text-[4.5rem] leading-none font-semibold text-fg"
            : "font-mono text-[3rem] leading-none font-semibold text-fg"
        }
      >
        {time ?? " "}
      </p>
      {showDate ? <p className="text-section-title text-fg-muted">{date ?? " "}</p> : null}
    </div>
  );
}

/** The chores widget without member actions (turned off, or while offline). */
export function DisplayChoreList({
  chores,
  count,
  dueLabel,
}: {
  readonly chores: readonly DisplayBoardChore[];
  readonly count: number;
  readonly dueLabel: (chore: DisplayBoardChore) => string;
}) {
  const t = useTranslations("DisplayBoard");
  if (chores.length === 0) return <p className="text-body text-fg-muted">{t("noChores")}</p>;
  const shown = chores.slice(0, count);
  return (
    <>
      <ul className="flex flex-col gap-2" data-testid="display-chore-list">
        {shown.map((chore) => (
          <li
            key={chore.occurrenceId}
            className="flex flex-col rounded-control border border-line bg-surface px-4 py-3 text-start"
          >
            <span className="text-body font-medium text-fg" dir="auto">
              {chore.title}
            </span>
            <span className="text-helper text-fg-muted">{dueLabel(chore)}</span>
          </li>
        ))}
      </ul>
      {chores.length > shown.length ? (
        <p className="text-helper text-fg-muted">
          {t("more", { count: chores.length - shown.length })}
        </p>
      ) : null}
    </>
  );
}

const NO_NAMES = { byId: new Map<string, string | null>(), selfId: null };

/** The shopping widget: active items of the chosen (or all) Home lists, read-only. */
export function DisplayShopping({
  lists,
  listIds,
  count,
}: {
  readonly lists: readonly DisplayBoardList[];
  readonly listIds: readonly string[];
  readonly count: number;
}) {
  const t = useTranslations("DisplayBoard");
  const texts = useShoppingTexts(NO_NAMES);
  // Chosen lists in the chosen order; a chosen list that is gone is simply left out here (the
  // managers' page says so).
  const shown =
    listIds.length === 0
      ? lists
      : listIds.flatMap((id) => lists.filter((list) => list.listId === id));
  if (shown.length === 0) return <p className="text-body text-fg-muted">{t("noLists")}</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="display-shopping">
      {shown.map((list) => (
        <section key={list.listId} className="flex flex-col gap-2 text-start">
          <h3 className="text-body font-semibold text-fg">
            <bdi>{list.name}</bdi>
          </h3>
          {list.items.length === 0 ? (
            <p className="text-helper text-fg-muted">{t("listDone")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {list.items.slice(0, count).map((item) => {
                const amount = texts.amount(item.quantity, item.unit);
                return (
                  <li key={item.itemId} className="text-body text-fg">
                    <bdi>{item.name}</bdi>
                    {amount ? <span className="text-fg-muted"> · {amount}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {list.remaining > Math.min(count, list.items.length) ? (
            <p className="text-helper text-fg-muted">
              {t("more", { count: list.remaining - Math.min(count, list.items.length) })}
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
