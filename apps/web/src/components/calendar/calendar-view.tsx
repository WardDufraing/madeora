import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { ReactNode } from "react";

import { readCalendar } from "@/calendar/data";
import {
  bannerSpan,
  calendarHref,
  calendarViewWindow,
  eventPath,
  newEventPath,
  occurrencesByDate,
  occurrenceTimes,
  type CalendarViewWindow,
} from "@/calendar/format";
import { calendarPageQuerySchema, calendarViews, type CalendarView } from "@/calendar/schema";
import type { Occurrence, VacationBanner } from "@/calendar/shapes";
import { PageHeader } from "@/components/shell/page-header";
import { cx } from "@/components/ui/cx";
import { ErrorState } from "@/components/ui/states";
import type { DateTimeFormats } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { itemStates, choreStateKey } from "@/chores/calendar";
import { listChoreSchedule } from "@/chores/data";
import { choresPath } from "@/chores/format";
import { getHomeDirectory } from "@/members/directory";
import { isoDate, weekdayNames } from "@/preferences/regional";
import { getEffectiveTimeZone, getRegionalFormats } from "@/preferences/server";
import { defaultCalendarQuery, inMonth } from "@/tasks/calendar";
import { listTaskCalendar } from "@/tasks/data";
import { defaultTaskQuery, taskQueryString } from "@/tasks/filters";
import { formatTaskDate, tasksPath } from "@/tasks/format";

import { CalendarToggles } from "./calendar-toggles";

export interface CalendarViewProps {
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

/** How many events a month cell lists before "+N more" (the day view shows them all). */
const MONTH_CELL_ENTRIES = 3;

const linkClass =
  "inline-flex min-h-10 items-center px-2 text-body font-medium text-accent-fg underline";

/** Names of a Home's members by membership id, for "Shared by". */
export type MemberNames = ReadonlyMap<string, string | null>;

/** A task or chore shown over the calendar: a view of its own record, never an event. */
interface OverlayEntry {
  readonly key: string;
  readonly kind: "task" | "chore";
  readonly title: string;
  readonly href: string | null;
  /** State in words (never colour alone): starts, done, overdue, planned, repeats… */
  readonly notes: readonly string[];
}

/**
 * The main calendar (S32; MOD §4.2): a month, week, day or agenda of the context's events, in the
 * context's timezone (the Home's, or the person's own for Personal). The Personal calendar shows the
 * person's own events only; a Home's shows its events and personal events shared with it, never a
 * "busy" block for anything else. Everything is read with the viewer's session, and the address
 * holds the whole view, so it works without JavaScript. Small screens get the agenda list.
 */
export async function CalendarView({ home, searchParams }: CalendarViewProps) {
  const homeId = home?.id ?? null;
  const query = calendarPageQuerySchema.parse({
    view: typeof searchParams.view === "string" ? searchParams.view : undefined,
    date: typeof searchParams.date === "string" ? searchParams.date : undefined,
  });
  const [t, tVacations, tTasks, tChores, formats, regional, directory, personalZone] =
    await Promise.all([
      getTranslations("Calendar"),
      getTranslations("Vacations"),
      getTranslations("TaskCalendar"),
      getTranslations("Chores"),
      getDateTimeFormats(),
      getRegionalFormats(),
      homeId ? getHomeDirectory(homeId) : Promise.resolve(null),
      getEffectiveTimeZone(),
    ]);
  // Today in the context's timezone: the same zone the database shows the calendar in.
  const today = isoDate(new Date(), home ? home.timeZone : personalZone.timeZone);
  const window = calendarViewWindow(query.view, query.date ?? today, regional.effective.weekStart);
  const calendar = await readCalendar(homeId, window.from, window.to);
  if (calendar.status !== "ok" || (directory && directory.status !== "ok")) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const value = calendar.value;
  const names: MemberNames = new Map(
    directory?.status === "ok"
      ? directory.members.map((member) => [member.membershipId, member.name])
      : [],
  );
  // The overlays read the same records as Tasks and Chores, with the viewer's session.
  const [tasks, chores] = await Promise.all([
    value.showTasks ? listTaskCalendar(homeId, window, defaultCalendarQuery) : null,
    homeId && value.showChores ? listChoreSchedule(homeId, window.from, window.to) : null,
  ]);
  const overlays = new Map<string, OverlayEntry[]>();
  const addOverlay = (date: string, entry: OverlayEntry) => {
    if (date < window.from || date > window.to) return;
    overlays.set(date, [...(overlays.get(date) ?? []), entry]);
  };
  if (tasks?.status === "ok") {
    tasks.value.entries.forEach((entry, index) => {
      const notes: string[] = [];
      if (entry.kind === "planned") notes.push(tTasks("markerPlanned"));
      else {
        if (entry.role === "start") notes.push(tTasks("markerStarts"));
        if (entry.completed) notes.push(tTasks("markerDone"));
        else if (entry.overdue && entry.role === "due") notes.push(tTasks("markerOverdue"));
      }
      if (entry.recurring) notes.push(tTasks("markerRepeats"));
      addOverlay(entry.date, {
        key: `task:${entry.taskId ?? "planned"}:${entry.date}:${entry.role}:${String(index)}`,
        kind: "task",
        title: entry.title,
        href: entry.taskId ? `${tasksPath(homeId)}/${entry.taskId}` : null,
        notes,
      });
    });
  }
  if (homeId && chores?.status === "ok") {
    chores.value.items.forEach((item, index) => {
      addOverlay(item.date, {
        key: `chore:${item.id ?? item.choreId}:${item.date}:${String(index)}`,
        kind: "chore",
        title: item.title,
        // A date a recurring chore has not reached yet has no occurrence to open.
        href: item.id ? `${choresPath(homeId)}/${item.id}` : null,
        notes: itemStates(item).map((state) => tChores(choreStateKey[state])),
      });
    });
  }
  const undatedHref = `${tasksPath(homeId)}?${taskQueryString({
    ...defaultTaskQuery,
    when: "undated",
    hideFuture: "0",
    sort: "due",
    offset: 0,
  })}`;
  const byDate = occurrencesByDate(value.occurrences, window.from, window.to);
  const banners = value.showVacations ? value.vacations : [];
  const dateText = (date: string) => formatTaskDate(date, formats);
  const title = windowTitle(window, formats, t, dateText);
  const href = (view: CalendarView, date?: string) => calendarHref(homeId, view, date);
  const viewLabel = {
    month: t("viewMonth"),
    week: t("viewWeek"),
    day: t("viewDay"),
    agenda: t("viewAgenda"),
  } as const satisfies Record<CalendarView, string>;
  const listDays = window.weeks
    .flat()
    .filter(
      (date) =>
        (window.view !== "month" || inMonth(date, window.anchor)) &&
        (byDate.has(date) || overlays.has(date) || bannersOn(banners, date).length > 0),
    );
  const item = (occurrence: Occurrence, date: string) => (
    <OccurrenceItem
      key={`${occurrence.eventId}:${occurrence.on ?? ""}`}
      occurrence={occurrence}
      date={date}
      homeId={homeId}
      timeZone={value.timezone}
      formats={formats}
      names={names}
    />
  );
  const overlayLabel = { task: t("overlayTask"), chore: t("overlayChore") } as const;
  const entriesOn = (date: string): ReactNode[] => [
    ...(byDate.get(date) ?? []).map((occurrence) => item(occurrence, date)),
    ...(overlays.get(date) ?? []).map((entry) => (
      <OverlayItem key={entry.key} entry={entry} label={overlayLabel[entry.kind]} />
    )),
  ];
  const bannerLabel = (banner: VacationBanner) => banner.name ?? tVacations("genericName");

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : t("personalSpace")}</bdi>
        {" · "}
        {t("shownIn", { zone: value.timezone })}
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-section-title font-semibold" data-testid="calendar-title">
            {title}
          </h2>
          <nav aria-label={t("navigation")} className="flex flex-wrap items-center gap-2">
            <ul className="flex flex-wrap gap-1" aria-label={t("viewChoice")}>
              {calendarViews.map((view) => (
                <li key={view}>
                  <Link
                    href={href(view, window.anchor)}
                    aria-current={window.view === view ? "page" : undefined}
                    className={cx(
                      "inline-flex min-h-10 items-center rounded-control px-3 text-body font-medium",
                      window.view === view
                        ? "bg-accent-subtle text-fg"
                        : "text-accent-fg underline",
                    )}
                    data-testid={`calendar-view-${view}`}
                  >
                    {viewLabel[view]}
                  </Link>
                </li>
              ))}
            </ul>
            <Link href={href(window.view, window.previous)} className={linkClass}>
              {t("previous")}
            </Link>
            <Link href={href(window.view)} className={linkClass}>
              {t("today")}
            </Link>
            <Link href={href(window.view, window.next)} className={linkClass}>
              {t("next")}
            </Link>
          </nav>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <CalendarToggles
            homeId={homeId}
            showTasks={value.showTasks}
            showChores={value.showChores}
            showVacations={value.showVacations}
          />
          {value.canCreate ? (
            <Link
              href={newEventPath(homeId, window.view === "day" ? window.anchor : undefined)}
              className="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-body font-medium text-on-accent"
              data-testid="calendar-new-event"
            >
              {t("newEvent")}
            </Link>
          ) : null}
        </div>

        {value.truncated ? (
          <p className="text-body text-warning" role="status">
            {t("truncated")}
          </p>
        ) : null}
        {tasks && tasks.status !== "ok" ? (
          <p className="text-body text-warning" role="status">
            {t("tasksFailed")}
          </p>
        ) : null}
        {chores && chores.status !== "ok" ? (
          <p className="text-body text-warning" role="status">
            {t("choresFailed")}
          </p>
        ) : null}
        {(tasks?.status === "ok" && tasks.value.truncated) ||
        (chores?.status === "ok" && chores.value.truncated) ? (
          <p className="text-body text-warning" role="status">
            {t("overlayTruncated")}
          </p>
        ) : null}
        {tasks?.status === "ok" && tasks.value.undated > 0 ? (
          <p className="text-body text-fg-muted" data-testid="calendar-undated-tasks">
            {t("undatedTasks", { count: tasks.value.undated })}{" "}
            <Link href={undatedHref} className="font-medium text-accent-fg underline">
              {t("undatedTasksLink")}
            </Link>
          </p>
        ) : null}

        {/* The list: the agenda and day views everywhere, and small screens for month and week. */}
        <div
          className={cx(window.view === "month" || window.view === "week" ? "sm:hidden" : null)}
          data-testid="calendar-agenda"
        >
          {listDays.length === 0 ? (
            <p className="text-body text-fg-muted">{t("empty")}</p>
          ) : (
            <ol className="flex flex-col gap-3" aria-label={t("listLabel", { range: title })}>
              {listDays.map((date) => (
                <li
                  key={date}
                  className="flex flex-col gap-1 border-b border-line pb-2"
                  data-testid="calendar-list-day"
                  data-date={date}
                >
                  <h3 className="font-semibold text-fg">
                    <Link
                      href={href("day", date)}
                      aria-current={date === value.today ? "date" : undefined}
                      className="underline-offset-2 hover:underline"
                    >
                      {dateText(date)}
                      {date === value.today ? ` · ${t("todayMarker")}` : ""}
                    </Link>
                  </h3>
                  {bannersOn(banners, date).map((banner) => (
                    <BannerLink key={banner.id} homeId={homeId} banner={banner}>
                      {t("vacationBanner", { name: bannerLabel(banner) })}
                    </BannerLink>
                  ))}
                  <ul className="flex flex-col gap-1">{entriesOn(date)}</ul>
                </li>
              ))}
            </ol>
          )}
        </div>

        {window.view === "month" || window.view === "week" ? (
          <MonthGrid
            window={window}
            today={value.today}
            entriesOn={entriesOn}
            banners={banners}
            bannerLabel={bannerLabel}
            homeId={homeId}
            title={title}
            formats={formats}
            weekStart={regional.effective.weekStart}
          />
        ) : null}
      </div>
    </>
  );
}

function bannersOn(banners: readonly VacationBanner[], date: string): VacationBanner[] {
  return banners.filter((banner) => banner.startsOn <= date && banner.endsOn >= date);
}

function windowTitle(
  window: CalendarViewWindow,
  formats: DateTimeFormats,
  t: Awaited<ReturnType<typeof getTranslations<"Calendar">>>,
  dateText: (date: string) => string,
): string {
  if (window.view === "month") {
    return new Intl.DateTimeFormat(formats.locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${window.anchor}T12:00:00Z`));
  }
  if (window.view === "day") {
    const weekday = new Intl.DateTimeFormat(formats.locale, {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(`${window.anchor}T12:00:00Z`));
    return t("dayTitle", { weekday, date: dateText(window.anchor) });
  }
  return t("range", { from: dateText(window.from), to: dateText(window.to) });
}

function BannerLink({
  homeId,
  banner,
  children,
}: {
  readonly homeId: string | null;
  readonly banner: VacationBanner;
  readonly children: string;
}) {
  // Banners are read-only: the vacation's own page shows (and checks) what the viewer may do.
  return homeId ? (
    <Link
      href={`/homes/${homeId}/vacations/${banner.id}`}
      className="block truncate rounded-control bg-warning-subtle px-2 py-0.5 text-helper font-medium text-fg"
      data-testid="calendar-vacation-banner"
    >
      <bdi>{children}</bdi>
    </Link>
  ) : null;
}

async function OccurrenceItem({
  occurrence,
  date,
  homeId,
  timeZone,
  formats,
  names,
}: {
  readonly occurrence: Occurrence;
  readonly date: string;
  readonly homeId: string | null;
  readonly timeZone: string;
  readonly formats: DateTimeFormats;
  readonly names: MemberNames;
}) {
  const t = await getTranslations("Calendar");
  const times = occurrenceTimes(occurrence, date, timeZone, formats);
  const when = !times
    ? t("allDay")
    : times.start && times.end
      ? t("timeRange", { start: times.start, end: times.end })
      : times.start
        ? t("timeFrom", { start: times.start })
        : times.end
          ? t("timeUntil", { end: times.end })
          : t("allDayContinues");
  const notes: string[] = [];
  if (occurrence.kind === "shared") {
    const name = occurrence.sharedBy ? names.get(occurrence.sharedBy) : null;
    notes.push(name ? t("sharedBy", { name }) : t("sharedByFormer"));
  }
  if (occurrence.recurring) notes.push(t("repeats"));
  if (!occurrence.allDay && occurrence.timezone !== timeZone) {
    notes.push(t("ownZone", { zone: occurrence.timezone }));
  }
  return (
    <li className="text-body" data-testid="calendar-event" data-kind={occurrence.kind}>
      <Link
        href={eventPath(homeId, occurrence.eventId, occurrence.on)}
        className="flex flex-col rounded-control px-1 text-fg underline-offset-2 hover:underline"
      >
        <span>
          <span className="text-fg-muted">{when}</span> <bdi>{occurrence.title}</bdi>
        </span>
        {notes.length > 0 ? (
          <span className="text-helper text-fg-muted">{notes.join(" · ")}</span>
        ) : null}
      </Link>
    </li>
  );
}

function OverlayItem({ entry, label }: { readonly entry: OverlayEntry; readonly label: string }) {
  const body = (
    <>
      <span>
        <span className="font-medium text-fg-muted">{label}</span> <bdi>{entry.title}</bdi>
      </span>
      {entry.notes.length > 0 ? (
        <span className="text-helper text-fg-muted">{entry.notes.join(" · ")}</span>
      ) : null}
    </>
  );
  return (
    <li
      className="border-s-2 border-dashed border-line ps-1 text-body"
      data-testid="calendar-overlay"
      data-kind={entry.kind}
    >
      {entry.href ? (
        <Link
          href={entry.href}
          className="flex flex-col rounded-control text-fg underline-offset-2 hover:underline"
        >
          {body}
        </Link>
      ) : (
        <span className="flex flex-col text-fg">{body}</span>
      )}
    </li>
  );
}

function MonthGrid({
  window,
  today,
  entriesOn,
  banners,
  bannerLabel,
  homeId,
  title,
  formats,
  weekStart,
}: {
  readonly window: CalendarViewWindow;
  readonly today: string;
  /** A day's events, then its tasks and chores. */
  readonly entriesOn: (date: string) => ReactNode[];
  readonly banners: readonly VacationBanner[];
  readonly bannerLabel: (banner: VacationBanner) => string;
  readonly homeId: string | null;
  readonly title: string;
  readonly formats: DateTimeFormats;
  readonly weekStart: Parameters<typeof weekdayNames>[0];
}) {
  const weekdays = weekdayNames(weekStart, formats.locale, "short");
  const weekdaysLong = weekdayNames(weekStart, formats.locale, "long");
  const dateText = (date: string) => formatTaskDate(date, formats);
  return (
    <div className="hidden overflow-x-auto sm:block">
      <table
        className="w-full min-w-[42rem] table-fixed border-collapse"
        data-testid="calendar-grid"
      >
        <caption className="sr-only">{title}</caption>
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
          {window.weeks.map((week) => {
            const weekBanners = banners.flatMap((banner) => {
              const span = bannerSpan(week, banner.startsOn, banner.endsOn);
              return span ? [{ banner, ...span }] : [];
            });
            return [
              // Each vacation is its own all-day row over its dates: overlapping ones never merge.
              ...weekBanners.map(({ banner, start, span }) => (
                <tr key={`${week[0] ?? ""}:${banner.id}`} data-testid="calendar-banner-row">
                  {start > 0 ? <td colSpan={start} /> : null}
                  <td colSpan={span} className="px-1 py-0.5">
                    <BannerLink homeId={homeId} banner={banner}>
                      {bannerLabel(banner)}
                    </BannerLink>
                  </td>
                  {start + span < week.length ? <td colSpan={week.length - start - span} /> : null}
                </tr>
              )),
              <tr key={week[0]}>
                {week.map((date) => {
                  const entries = entriesOn(date);
                  const shown =
                    window.view === "month" ? entries.slice(0, MONTH_CELL_ENTRIES) : entries;
                  const outside = window.view === "month" && !inMonth(date, window.anchor);
                  return (
                    <td
                      key={date}
                      className={cx(
                        "border border-line p-1 align-top",
                        window.view === "month" ? "h-28" : "h-48",
                        outside && "bg-page",
                      )}
                      data-testid="calendar-day"
                      data-date={date}
                    >
                      <Link
                        href={calendarHref(homeId, "day", date)}
                        aria-current={date === today ? "date" : undefined}
                        aria-label={dateText(date)}
                        className={cx(
                          "inline-flex min-h-8 min-w-8 items-center justify-center rounded-control px-1 text-body font-medium",
                          date === today
                            ? "bg-accent text-on-accent"
                            : "text-fg underline-offset-2 hover:underline",
                          outside && date !== today && "text-fg-muted",
                        )}
                      >
                        {Number(date.slice(8, 10))}
                      </Link>
                      {shown.length > 0 ? (
                        <ul className="mt-1 flex flex-col gap-0.5 text-helper">
                          {shown}
                          {entries.length > shown.length ? (
                            <li>
                              <Link
                                href={calendarHref(homeId, "day", date)}
                                className="text-fg-muted underline"
                              >
                                <MoreText count={entries.length - shown.length} />
                              </Link>
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </td>
                  );
                })}
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

async function MoreText({ count }: { readonly count: number }) {
  const t = await getTranslations("Calendar");
  return <>{t("more", { count })}</>;
}
