"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  CHORE_SCHEDULE_ENDPOINT,
  sendChoreRequest,
  type ChoreAgenda,
  type ChoreAgendaItem,
  type ChorePool,
  type ChorePoolRow,
} from "@/chores/api";
import { itemStates } from "@/chores/calendar";
import { choresPath } from "@/chores/format";
import type { WidgetConfigs } from "@/dashboard/widgets";
import type { DateTimeFormats } from "@/invitations/format";
import { addDays, daysBetween } from "@/tasks/calendar";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { stateKey } from "./chore-calendar-board";
import { ClaimButton } from "./chore-pool";
import { useChoreTexts } from "./use-chore-texts";

type Layout = WidgetConfigs["chore-schedule"]["layout"];
type Mode = "week" | "day";

const POOL_ENDPOINT = "/api/v1/chore-pool";
/** The group key for chores nobody is assigned to (outside the pool, e.g. needing reassignment). */
const NOBODY = "nobody";

/** Where a viewer's own layout choice for one widget is kept (a per-browser convenience). */
export function layoutStorageKey(widgetId: string): string {
  return `madeora:chore-schedule:${widgetId}:layout`;
}

function readLayout(widgetId: string): Layout | null {
  try {
    const value = window.localStorage.getItem(layoutStorageKey(widgetId));
    return value === "matrix" || value === "cards" ? value : null;
  } catch {
    return null;
  }
}

function writeLayout(widgetId: string, layout: Layout): void {
  try {
    window.localStorage.setItem(layoutStorageKey(widgetId), layout);
  } catch {
    // Storage blocked: the choice lasts until the page is left.
  }
}

export interface ChoreScheduleWidgetProps {
  readonly homeId: string;
  readonly widgetId: string;
  /** The viewer, so cached reads are never shared between accounts. */
  readonly userId: string;
  readonly config: WidgetConfigs["chore-schedule"];
  readonly today: string;
  /** The Home's current week's first day. */
  readonly weekStart: string;
  /** Short and long weekday names from the Home's week start on. */
  readonly weekdays: readonly string[];
  readonly weekdaysLong: readonly string[];
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  /** The current week, read with the page. */
  readonly agenda: ChoreAgenda;
  readonly pool: ChorePool;
  readonly loadedAt: string;
}

/**
 * The Chore schedule widget (S21; spec "Confirmed Home chore overview widget"): the Home-local week
 * (or one day of it) as a member-by-day matrix or as daily cards grouped by member, with today
 * marked in words. Each cell lists a few chores and "+N more" opens the rest in place. Below, the
 * unassigned chores of the shown week to claim; in Day view they are filtered to the day, with the
 * whole week one step away. On a narrow widget the matrix becomes a list of the selected day.
 */
export function ChoreScheduleWidget({
  homeId,
  widgetId,
  userId,
  config,
  today,
  weekStart,
  weekdays,
  weekdaysLong,
  members,
  formats,
  agenda,
  pool,
  loadedAt,
}: ChoreScheduleWidgetProps) {
  const t = useTranslations("ChoreWidgets");
  const tChores = useTranslations("Chores");
  const names = memberNames(members);
  const texts = useChoreTexts(names);
  const hydrated = useHydrated();
  const [chosen, setChosen] = useState<Layout | null>(null);
  // The browser's remembered choice only after hydration, so both first renders agree.
  const layout = chosen ?? (hydrated ? readLayout(widgetId) : null) ?? config.layout;
  const [mode, setMode] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(weekStart);
  const [day, setDay] = useState(today);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const to = addDays(anchor, 6);
  const current = anchor === weekStart;
  const schedule = useQuery<ChoreAgenda>({
    queryKey: ["chores", userId, "schedule", homeId, anchor, loadedAt],
    queryFn: () =>
      sendChoreRequest<ChoreAgenda>(
        "GET",
        `${CHORE_SCHEDULE_ENDPOINT}?homeId=${encodeURIComponent(homeId)}&from=${anchor}&to=${to}`,
      ),
    ...(current ? { initialData: agenda } : {}),
    // The page's own read is fresh; claims and moves invalidate it.
    staleTime: 60_000,
    retry: false,
  });
  const poolRead = useQuery<ChorePool>({
    queryKey: ["chores", userId, "schedule-pool", homeId, anchor, loadedAt],
    queryFn: async () =>
      (
        await sendChoreRequest<{ pool: ChorePool }>(
          "GET",
          `${POOL_ENDPOINT}?homeId=${encodeURIComponent(homeId)}&date=${anchor}`,
        )
      ).pool,
    ...(current ? { initialData: pool } : {}),
    staleTime: 60_000,
    retry: false,
  });

  const dates =
    mode === "week" ? Array.from({ length: 7 }, (_, index) => addDays(anchor, index)) : [day];
  const weekday = (date: string, long = false) =>
    (long ? weekdaysLong : weekdays)[((daysBetween(anchor, date) % 7) + 7) % 7] ?? "";
  const dateText = (date: string) => formatTaskDate(date, formats);
  const dayLabel = (date: string) =>
    [weekday(date, true), dateText(date), date === today ? t("scheduleTodayMarker") : null]
      .filter(Boolean)
      .join(", ");
  const title =
    mode === "week"
      ? t("scheduleWeekRange", { from: dateText(anchor), to: dateText(to) })
      : dayLabel(day);

  const go = (weeks: number) => {
    const next = addDays(anchor, weeks * 7);
    setAnchor(next);
    setDay(addDays(day, weeks * 7));
    setExpanded(new Set());
  };
  const goDay = (days: number) => {
    const next = addDays(day, days);
    setDay(next);
    if (next < anchor || next > to) setAnchor(addDays(anchor, days < 0 ? -7 : 7));
  };
  const goToday = () => {
    setAnchor(weekStart);
    setDay(today);
    setExpanded(new Set());
  };
  const chooseLayout = (next: Layout) => {
    setChosen(next);
    writeLayout(widgetId, next);
  };
  const toggle = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const poolRows = poolRead.data?.rows ?? [];
  const inPool = new Set(poolRows.map((row) => row.id));
  const items = (schedule.data?.items ?? []).filter((item) => !item.id || !inPool.has(item.id));
  const groupsOf = (item: ChoreAgendaItem) =>
    item.assigneeIds.length === 0 ? [NOBODY] : item.assigneeIds.map((id) => id ?? NOBODY);
  const cellItems = (group: string, date: string) =>
    items.filter((item) => item.date === date && groupsOf(item).includes(group));
  const groupName = (group: string) =>
    group === NOBODY
      ? t("scheduleNobody")
      : group === names.selfId
        ? t("scheduleYou")
        : texts.member(group);
  const rows = [
    ...members.map((member) => member.id),
    ...(items.some((item) => groupsOf(item).includes(NOBODY)) ? [NOBODY] : []),
  ];
  const shownPool = poolRows.filter(
    (row) => mode === "week" || row.section === "overdue" || row.scheduledDate === day,
  );

  const chip = (item: ChoreAgendaItem, index: number) => {
    const words = itemStates(item).map((state) => tChores(stateKey[state]));
    const done = item.status === "completed" || item.status === "skipped";
    return (
      <li key={`${item.id ?? item.choreId}:${String(index)}`} data-testid="chore-schedule-item">
        {item.id ? (
          <Link
            href={`${choresPath(homeId)}/${item.id}`}
            className={cx(
              "text-helper font-medium underline-offset-2 hover:underline",
              done ? "text-fg-muted line-through" : "text-fg",
            )}
          >
            <bdi>{item.title}</bdi>
          </Link>
        ) : (
          <bdi className="text-helper font-medium text-fg">{item.title}</bdi>
        )}
        {words.length > 0 ? (
          <span className="text-helper text-fg-muted"> · {words.join(" · ")}</span>
        ) : null}
      </li>
    );
  };

  const cell = (key: string, entries: readonly ChoreAgendaItem[], label: string) => {
    const open = expanded.has(key);
    const shown = open ? entries : entries.slice(0, config.limit);
    const hidden = entries.length - shown.length;
    return (
      <>
        {shown.length > 0 ? (
          <ul className="flex flex-col gap-0.5" aria-label={label}>
            {shown.map(chip)}
          </ul>
        ) : null}
        {hidden > 0 || open ? (
          <button
            type="button"
            className="min-h-6 text-helper font-medium text-accent-fg underline"
            aria-expanded={open}
            aria-label={
              open
                ? t("scheduleLessLabel", { cell: label })
                : t("scheduleMoreLabel", { count: hidden, cell: label })
            }
            onClick={() => {
              toggle(key);
            }}
            data-testid="chore-schedule-more"
          >
            {open ? t("scheduleLess") : t("scheduleMore", { count: hidden })}
          </button>
        ) : null}
      </>
    );
  };

  const groupedDay = (date: string) => {
    const groups = rows
      .map((group) => ({ group, entries: cellItems(group, date) }))
      .filter((entry) => entry.entries.length > 0);
    if (groups.length === 0) {
      return <p className="text-helper text-fg-muted">{t("scheduleDayEmpty")}</p>;
    }
    return (
      <ul className="flex flex-col gap-2">
        {groups.map(({ group, entries }) => (
          <li key={group} className="flex flex-col gap-0.5">
            <span className="text-helper font-semibold text-fg">
              <bdi>{groupName(group)}</bdi>
            </span>
            {cell(`${group}:${date}`, entries, `${groupName(group)}, ${dayLabel(date)}`)}
          </li>
        ))}
      </ul>
    );
  };

  const toggleButton = (pressed: boolean, label: string, onClick: () => void, testId: string) => (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        "inline-flex min-h-8 items-center rounded-control px-2 text-helper font-medium",
        pressed ? "bg-accent-subtle text-fg" : "text-accent-fg underline",
      )}
      data-testid={testId}
    >
      {label}
    </button>
  );

  return (
    <div className="@container flex flex-col gap-3" data-testid="chore-schedule">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body font-semibold text-fg" data-testid="chore-schedule-title">
          {title}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <div role="group" aria-label={t("scheduleViewChoice")} className="flex gap-1">
            {toggleButton(
              mode === "week",
              t("scheduleWeek"),
              () => {
                setMode("week");
              },
              "chore-schedule-week",
            )}
            {toggleButton(
              mode === "day",
              t("scheduleDay"),
              () => {
                setMode("day");
                if (day < anchor || day > to) setDay(anchor);
              },
              "chore-schedule-day",
            )}
          </div>
          <div role="group" aria-label={t("scheduleLayoutChoice")} className="flex gap-1">
            {toggleButton(
              layout === "matrix",
              t("scheduleLayoutMatrix"),
              () => {
                chooseLayout("matrix");
              },
              "chore-schedule-matrix",
            )}
            {toggleButton(
              layout === "cards",
              t("scheduleLayoutCards"),
              () => {
                chooseLayout("cards");
              },
              "chore-schedule-cards",
            )}
          </div>
        </div>
      </div>
      <nav aria-label={t("scheduleNavigation")} className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (mode === "week") go(-1);
            else goDay(-1);
          }}
          data-testid="chore-schedule-previous"
        >
          {mode === "week" ? t("schedulePreviousWeek") : t("schedulePreviousDay")}
        </Button>
        <Button size="sm" variant="ghost" onClick={goToday} data-testid="chore-schedule-today">
          {t("scheduleToday")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (mode === "week") go(1);
            else goDay(1);
          }}
          data-testid="chore-schedule-next"
        >
          {mode === "week" ? t("scheduleNextWeek") : t("scheduleNextDay")}
        </Button>
      </nav>

      {schedule.isPending ? (
        <p className="text-helper text-fg-muted" role="status">
          {t("scheduleLoading")}
        </p>
      ) : schedule.isError ? (
        <p className="text-helper text-danger" role="alert">
          {t("scheduleFailed")}
        </p>
      ) : (
        <>
          {schedule.data.truncated ? (
            <p className="text-helper text-warning" role="status">
              {t("scheduleTruncated")}
            </p>
          ) : null}
          {layout === "matrix" ? (
            <>
              <div className="hidden overflow-x-auto @2xl:block">
                <table
                  className="w-full table-fixed border-collapse"
                  data-testid="chore-schedule-matrix-table"
                >
                  <caption className="sr-only">
                    {t("scheduleMatrixCaption", { range: title })}
                  </caption>
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="w-28 px-1 py-1 text-start text-helper text-fg-muted"
                      >
                        {t("scheduleMemberColumn")}
                      </th>
                      {dates.map((date) => (
                        <th
                          key={date}
                          scope="col"
                          aria-current={date === today ? "date" : undefined}
                          className={cx(
                            "px-1 py-1 text-start text-helper font-medium",
                            date === today ? "bg-accent-subtle text-fg" : "text-fg-muted",
                          )}
                        >
                          <abbr title={dayLabel(date)} className="no-underline">
                            {weekday(date)} {Number(date.slice(8, 10))}
                          </abbr>
                          {date === today ? (
                            <span className="block font-semibold">{t("scheduleTodayMarker")}</span>
                          ) : null}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((group) => (
                      <tr key={group}>
                        <th
                          scope="row"
                          className="border-t border-line px-1 py-1 text-start align-top text-helper font-semibold text-fg"
                        >
                          <bdi>{groupName(group)}</bdi>
                        </th>
                        {dates.map((date) => (
                          <td
                            key={date}
                            className={cx(
                              "border-t border-line px-1 py-1 align-top",
                              date === today && "bg-accent-subtle/40",
                            )}
                            data-testid="chore-schedule-cell"
                          >
                            {cell(
                              `${group}:${date}`,
                              cellItems(group, date),
                              `${groupName(group)}, ${dayLabel(date)}`,
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* A narrow widget: the selected day of the shown week as a list. */}
              <div
                className="flex flex-col gap-2 @2xl:hidden"
                data-testid="chore-schedule-day-list"
              >
                {mode === "week" ? (
                  <div
                    role="group"
                    aria-label={t("scheduleDayChoice")}
                    className="flex flex-wrap gap-1"
                  >
                    {Array.from({ length: 7 }, (_, index) => addDays(anchor, index)).map((date) => (
                      <button
                        key={date}
                        type="button"
                        aria-pressed={date === (day >= anchor && day <= to ? day : anchor)}
                        aria-label={dayLabel(date)}
                        onClick={() => {
                          setDay(date);
                        }}
                        className={cx(
                          "inline-flex min-h-8 min-w-10 items-center justify-center rounded-control px-1 text-helper font-medium",
                          date === (day >= anchor && day <= to ? day : anchor)
                            ? "bg-accent text-on-accent"
                            : "text-accent-fg underline",
                        )}
                      >
                        {weekday(date)} {Number(date.slice(8, 10))}
                      </button>
                    ))}
                  </div>
                ) : null}
                {groupedDay(day >= anchor && day <= to ? day : anchor)}
              </div>
            </>
          ) : (
            <ol
              className="grid gap-2 @lg:grid-cols-2 @3xl:grid-cols-3"
              data-testid="chore-schedule-cards-list"
            >
              {dates.map((date) => (
                <li
                  key={date}
                  aria-current={date === today ? "date" : undefined}
                  className={cx(
                    "flex flex-col gap-2 rounded-card border p-2",
                    date === today ? "border-accent" : "border-line",
                  )}
                  data-testid="chore-schedule-card"
                >
                  <h3 className="text-helper font-semibold text-fg">{dayLabel(date)}</h3>
                  {groupedDay(date)}
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      <section
        aria-labelledby={`${widgetId}-unassigned`}
        className="flex flex-col gap-2 border-t border-line pt-2"
        data-testid="chore-schedule-unassigned"
      >
        <h3 id={`${widgetId}-unassigned`} className="text-body font-semibold text-fg">
          {t("scheduleUnassignedHeading")}
        </h3>
        {mode === "day" ? (
          <p className="text-helper text-fg-muted">
            {t("scheduleUnassignedDayNote", { date: dateText(day) })}{" "}
            <button
              type="button"
              className="font-medium text-accent-fg underline"
              onClick={() => {
                setMode("week");
              }}
              data-testid="chore-schedule-whole-week"
            >
              {t("scheduleWholeWeek")}
            </button>
          </p>
        ) : null}
        {poolRead.isPending ? (
          <p className="text-helper text-fg-muted">{t("scheduleLoading")}</p>
        ) : poolRead.isError ? (
          <p className="text-helper text-danger" role="alert">
            {t("scheduleFailed")}
          </p>
        ) : shownPool.length === 0 ? (
          <p className="text-helper text-fg-muted">{t("scheduleUnassignedEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {shownPool.map((row) => (
              <UnassignedRow key={row.id} homeId={homeId} row={row} dateText={dateText} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UnassignedRow({
  homeId,
  row,
  dateText,
}: {
  readonly homeId: string;
  readonly row: ChorePoolRow;
  readonly dateText: (date: string) => string;
}) {
  const t = useTranslations("ChoreWidgets");
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 py-1.5"
      data-testid="chore-schedule-unassigned-row"
    >
      <div className="flex min-w-0 flex-col">
        <Link
          href={`${choresPath(homeId)}/${row.id}`}
          className="text-helper font-medium text-fg underline-offset-2 hover:underline"
        >
          <bdi>{row.title}</bdi>
        </Link>
        <span className="text-helper text-fg-muted">
          {row.overdue
            ? t("scheduleUnassignedOverdue", { date: dateText(row.dueDate) })
            : t("scheduleUnassignedDue", { date: dateText(row.dueDate) })}
        </span>
      </div>
      {row.eligible ? (
        <ClaimButton occurrenceId={row.id} title={row.title} />
      ) : (
        <span className="text-helper font-medium text-fg-muted">{t("scheduleNotEligible")}</span>
      )}
    </li>
  );
}
