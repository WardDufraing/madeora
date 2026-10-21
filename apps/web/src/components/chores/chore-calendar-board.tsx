"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import type { ChoreAgendaItem } from "@/chores/api";
import {
  byDate,
  choreCalendarQueryString,
  isMovable,
  itemStates,
  type ChoreCalendarQuery,
  type ChoreItemState,
} from "@/chores/calendar";
import { choresPath } from "@/chores/format";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { ChoreMove } from "./chore-move";
import { useChoreTexts } from "./use-chore-texts";

/** How many chores a month cell lists before "+N more" (the day panel shows them all). */
const MONTH_CELL_ITEMS = 3;
const DRAG_TYPE = "application/x-madeora-chore";

export interface ChoreCalendarBoardProps {
  readonly homeId: string;
  readonly query: ChoreCalendarQuery;
  /** The view's anchor (any day of the week, or the 1st of the month). */
  readonly anchor: string;
  readonly weeks: readonly (readonly string[])[];
  readonly today: string;
  /** The day whose chores the panel lists. */
  readonly selected: string | null;
  readonly items: readonly ChoreAgendaItem[];
  readonly members: readonly MemberOption[];
  readonly canManage: boolean;
  readonly formats: DateTimeFormats;
  readonly weekdays: readonly string[];
  readonly weekdaysLong: readonly string[];
  readonly title: string;
}

export const stateKey = {
  overdue: "calendarStateOverdue",
  pending: "calendarStatePending",
  rework: "calendarStateRework",
  completed: "calendarStateCompleted",
  skipped: "calendarStateSkipped",
  expired: "calendarStateExpired",
  review: "calendarStateReview",
  awaiting: "calendarStateAwaiting",
  planned: "calendarStatePlanned",
} as const satisfies Record<ChoreItemState, string>;

/**
 * The Chores calendar's grid, agenda and day panel (S21). Every chore shows its state in words.
 * Chore managers move an open occurrence by dragging it onto another day (the Move dialog then
 * opens on that day for the preview and confirmation) or with its Move button, which works with a
 * keyboard and on touch screens. Projected dates of recurring chores are listed but never moved.
 */
export function ChoreCalendarBoard({
  homeId,
  query,
  anchor,
  weeks,
  today,
  selected,
  items,
  members,
  canManage,
  formats,
  weekdays,
  weekdaysLong,
  title,
}: ChoreCalendarBoardProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const [moving, setMoving] = useState<{
    readonly item: ChoreAgendaItem;
    readonly date: string | null;
  } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const days = byDate(items);
  const base = `${choresPath(homeId)}/calendar`;
  const href = (changes: Partial<ChoreCalendarQuery>) => {
    const search = choreCalendarQueryString(query, changes);
    return search ? `${base}?${search}` : base;
  };
  const dateText = (date: string) => formatTaskDate(date, formats);
  const states = (item: ChoreAgendaItem) => itemStates(item).map((state) => t(stateKey[state]));
  const who = (item: ChoreAgendaItem) =>
    item.assigneeIds.length === 0
      ? t("unassigned")
      : item.assigneeIds.map((id) => texts.member(id)).join(", ");
  const month = query.view === "month";
  const outside = (date: string) => month && date.slice(0, 7) !== anchor.slice(0, 7);
  const byId = new Map(items.flatMap((item) => (item.id ? [[item.id, item] as const] : [])));

  const drop = (date: string) => (event: DragEvent<HTMLTableCellElement>) => {
    event.preventDefault();
    const id = event.dataTransfer.getData(DRAG_TYPE);
    const item = byId.get(id);
    setDragging(null);
    setDropOn(null);
    if (item && item.date !== date) setMoving({ item, date });
  };

  const chip = (item: ChoreAgendaItem, index: number) => {
    const movable = canManage && isMovable(item);
    const words = states(item);
    const done = item.status === "completed" || item.status === "skipped";
    const chipClass = cx(
      "block truncate rounded-control px-1 text-helper underline-offset-2 hover:bg-surface-sunken hover:underline",
      done ? "text-fg-muted line-through" : "text-fg",
    );
    const label = (
      <>
        <bdi>{item.title}</bdi>
        {words.length > 0 ? <span className="text-fg-muted"> · {words.join(" · ")}</span> : null}
      </>
    );
    return (
      <li
        key={`${item.id ?? item.choreId}:${item.date}:${String(index)}`}
        data-testid="chore-calendar-item"
      >
        {item.id ? (
          // Dragging is the pointer shortcut; the day panel's Move button is the keyboard way.
          <Link
            href={`${choresPath(homeId)}/${item.id}`}
            draggable={movable}
            onDragStart={
              movable
                ? (event) => {
                    event.dataTransfer.setData(DRAG_TYPE, item.id ?? "");
                    event.dataTransfer.effectAllowed = "move";
                    setDragging(item.id);
                  }
                : (event) => {
                    event.preventDefault();
                  }
            }
            onDragEnd={() => {
              setDragging(null);
              setDropOn(null);
            }}
            className={cx(
              chipClass,
              movable && "cursor-grab",
              dragging === item.id && "opacity-50",
            )}
          >
            {label}
          </Link>
        ) : (
          <span className={chipClass}>{label}</span>
        )}
      </li>
    );
  };

  const selectedItems = selected ? (days.get(selected) ?? []) : [];

  return (
    <div className="flex flex-col gap-5">
      {/* Small screens get an agenda of the days with chores instead of the grid. */}
      <div className="sm:hidden" data-testid="chore-calendar-agenda">
        {weeks.flat().every((date) => !days.has(date) || outside(date)) ? (
          <p className="text-body text-fg-muted">{t("calendarEmpty")}</p>
        ) : (
          <ol
            className="flex flex-col gap-3"
            aria-label={t("calendarAgendaLabel", { range: title })}
          >
            {weeks
              .flat()
              .filter((date) => days.has(date) && !outside(date))
              .map((date) => (
                <li key={date} className="flex flex-col gap-1 border-b border-line pb-2">
                  <Link
                    href={href({ date: anchor, day: date })}
                    aria-current={date === today ? "date" : undefined}
                    className="font-semibold text-fg underline-offset-2 hover:underline"
                  >
                    {dateText(date)}
                    {date === today ? ` · ${t("calendarToday")}` : ""}
                  </Link>
                  <ul className="flex flex-col gap-0.5">{(days.get(date) ?? []).map(chip)}</ul>
                </li>
              ))}
          </ol>
        )}
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table
          className="w-full min-w-[42rem] table-fixed border-collapse"
          data-testid="chore-calendar"
        >
          <caption className="sr-only">{t("calendarCaption", { range: title })}</caption>
          <thead>
            <tr>
              {weekdays.map((day, index) => (
                <th
                  key={day}
                  scope="col"
                  className="px-2 py-1 text-start text-helper font-medium text-fg-muted"
                >
                  <abbr title={weekdaysLong[index]} className="no-underline">
                    {day}
                  </abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]}>
                {week.map((date) => {
                  const entries = days.get(date) ?? [];
                  const shown = month ? entries.slice(0, MONTH_CELL_ITEMS) : entries;
                  return (
                    <td
                      key={date}
                      onDragOver={
                        dragging
                          ? (event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setDropOn(date);
                            }
                          : undefined
                      }
                      onDragLeave={() => {
                        setDropOn((current) => (current === date ? null : current));
                      }}
                      onDrop={dragging ? drop(date) : undefined}
                      className={cx(
                        "h-28 border border-line p-1 align-top",
                        outside(date) && "bg-page",
                        date === selected && "outline outline-2 -outline-offset-2 outline-accent",
                        dropOn === date && "bg-accent-subtle",
                      )}
                      data-testid="chore-calendar-day"
                      data-date={date}
                    >
                      <Link
                        href={href({ date: anchor, day: date })}
                        aria-current={date === today ? "date" : undefined}
                        aria-label={[
                          dateText(date),
                          date === today ? t("calendarToday") : null,
                          date === selected ? t("calendarSelected") : null,
                          t("calendarDayCount", { count: entries.length }),
                        ]
                          .filter(Boolean)
                          .join(", ")}
                        className={cx(
                          "inline-flex min-h-8 min-w-8 items-center justify-center rounded-control px-1 text-body font-medium",
                          date === today
                            ? "bg-accent text-on-accent"
                            : "text-fg underline-offset-2 hover:underline",
                          outside(date) && date !== today && "text-fg-muted",
                        )}
                      >
                        {Number(date.slice(8, 10))}
                      </Link>
                      {shown.length > 0 ? (
                        <ul
                          className="mt-1 flex flex-col gap-0.5"
                          aria-label={t("calendarAgendaLabel", { range: dateText(date) })}
                        >
                          {shown.map(chip)}
                        </ul>
                      ) : null}
                      {entries.length > shown.length ? (
                        <Link
                          href={href({ date: anchor, day: date })}
                          className="text-helper font-medium text-accent-fg underline"
                          tabIndex={-1}
                          aria-hidden="true"
                        >
                          {t("calendarMore", { count: entries.length - shown.length })}
                        </Link>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected ? (
        <section
          aria-labelledby="chore-calendar-day-heading"
          className="flex flex-col gap-3"
          data-testid="chore-calendar-panel"
        >
          <h2 id="chore-calendar-day-heading" className="text-section-title font-semibold text-fg">
            {dateText(selected)}
            {selected === today ? ` · ${t("calendarToday")}` : ""}
          </h2>
          {selectedItems.length === 0 ? (
            <p className="text-body text-fg-muted">{t("calendarDayEmpty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
              {selectedItems.map((item, index) => {
                const words = states(item);
                return (
                  <li
                    key={`${item.id ?? item.choreId}:${String(index)}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                    data-testid="chore-calendar-panel-item"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      {item.id ? (
                        <Link
                          href={`${choresPath(homeId)}/${item.id}`}
                          className="text-body font-semibold text-fg underline-offset-2 hover:underline"
                        >
                          <bdi>{item.title}</bdi>
                        </Link>
                      ) : (
                        <span className="text-body font-semibold text-fg">
                          <bdi>{item.title}</bdi>
                        </span>
                      )}
                      <p className="flex flex-wrap gap-x-3 gap-y-1 text-helper text-fg-muted">
                        <span>{who(item)}</span>
                        {item.category ? <span>{item.category.name}</span> : null}
                        {item.minutes !== null ? (
                          <span>{t("minutes", { count: item.minutes })}</span>
                        ) : null}
                        {words.map((word) => (
                          <span key={word} className="font-semibold text-fg">
                            {word}
                          </span>
                        ))}
                      </p>
                    </div>
                    {canManage && isMovable(item) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setMoving({ item, date: null });
                        }}
                        aria-label={t("moveNamed", { title: item.title })}
                        data-testid="chore-calendar-move"
                      >
                        {t("move")}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <ChoreMove
        item={moving?.item ?? null}
        targetDate={moving?.date ?? null}
        members={members}
        formats={formats}
        onClose={() => {
          setMoving(null);
        }}
      />
    </div>
  );
}
