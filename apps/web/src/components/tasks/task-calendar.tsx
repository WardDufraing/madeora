import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cx } from "@/components/ui/cx";
import { SelectField } from "@/components/ui/select-field";
import { ErrorState } from "@/components/ui/states";
import type { DateTimeFormats } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { weekdayNames } from "@/preferences/regional";
import { getRegionalFormats } from "@/preferences/server";
import type { CalendarEntry, TaskRow } from "@/tasks/api";
import {
  calendarQueryString,
  calendarWindow,
  hasCalendarFilters,
  inMonth,
  parseCalendarQuery,
} from "@/tasks/calendar";
import {
  advanceSeries,
  getTaskContext,
  listTaskCalendar,
  listTaskLabels,
  listTaskLists,
  listTaskMembers,
} from "@/tasks/data";
import { taskQueryString } from "@/tasks/filters";
import { formatTaskDate, tasksPath, type MemberOption } from "@/tasks/format";
import { taskPriorities, type CalendarQuery } from "@/tasks/schema";

import { CompactTaskList } from "./compact-task-list";
import type { LabelOption } from "./label-picker";
import { TaskViewSwitch } from "./task-view-switch";

export interface TaskCalendarProps {
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

/** How many entries a month cell lists before "+N more" (the day panel shows them all). */
const MONTH_CELL_ENTRIES = 3;

/**
 * The optional task calendar (S19c; spec "Confirmed optional task calendar views"): a week or month
 * of the context's tasks on their due dates, with start dates marked and planned dates of recurring
 * series, in the context's timezone ("today" comes from the database). Selecting a day lists its
 * tasks with the same completion as the list; editing happens on the task page. Everything is read
 * with the viewer's session, and the address holds the whole view, so it works without JavaScript.
 */
export async function TaskCalendar({ home, searchParams }: TaskCalendarProps) {
  const homeId = home?.id ?? null;
  const query = parseCalendarQuery(searchParams);
  await advanceSeries(homeId);
  const [t, tTasks, formats, regional, context, lists, labels, members] = await Promise.all([
    getTranslations("TaskCalendar"),
    getTranslations("Tasks"),
    getDateTimeFormats(),
    getRegionalFormats(),
    getTaskContext(homeId),
    listTaskLists(homeId, true),
    listTaskLabels(homeId),
    homeId ? listTaskMembers(homeId) : Promise.resolve({ status: "ok", value: [] } as const),
  ]);
  if (
    context.status !== "ok" ||
    lists.status !== "ok" ||
    labels.status !== "ok" ||
    members.status !== "ok"
  ) {
    return <ErrorState title={tTasks("loadFailedTitle")} description={tTasks("loadFailed")} />;
  }
  const today = context.value.today;
  const window = calendarWindow(query.view, query.date ?? today, regional.effective.weekStart);
  const current = query.list ? lists.value.find((list) => list.id === query.list) : undefined;
  const effective: CalendarQuery = current ? query : { ...query, list: undefined };
  const calendar = await listTaskCalendar(homeId, window, effective);
  if (calendar.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }

  const base = `${tasksPath(homeId)}/calendar`;
  const href = (changes: Partial<CalendarQuery>) => {
    const search = calendarQueryString(effective, changes);
    return search ? `${base}?${search}` : base;
  };
  const inWindow = (date: string) => date >= window.from && date <= window.to;
  const selected = query.day && inWindow(query.day) ? query.day : inWindow(today) ? today : null;
  const byDate = new Map<string, CalendarEntry[]>();
  for (const entry of calendar.value.entries) {
    byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  }
  const labelOptions = labels.value.map(({ id, name, color }) => ({ id, name, color }));
  const dateText = (date: string) => formatTaskDate(date, formats);
  const weekdays = weekdayNames(regional.effective.weekStart, formats.locale, "short");
  const weekdaysLong = weekdayNames(regional.effective.weekStart, formats.locale, "long");
  const title =
    window.view === "month"
      ? new Intl.DateTimeFormat(formats.locale, {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${window.anchor}T12:00:00Z`))
      : t("weekRange", { from: dateText(window.from), to: dateText(window.to) });
  const marker = (entry: CalendarEntry): string[] => {
    const parts: string[] = [];
    if (entry.kind === "planned") parts.push(t("markerPlanned"));
    else {
      if (entry.role === "start") parts.push(t("markerStarts"));
      if (entry.completed) parts.push(t("markerDone"));
      else if (entry.overdue && entry.role === "due") parts.push(t("markerOverdue"));
    }
    if (entry.recurring) parts.push(t("markerRepeats"));
    return parts;
  };
  // The list with the same filters as the count of tasks without a due date.
  const undatedHref = `${tasksPath(homeId)}?${taskQueryString({
    list: effective.list,
    status: effective.status,
    when: "undated",
    hideFuture: "0",
    priority: effective.priority,
    label: effective.label,
    assignee: effective.assignee,
    member: effective.member,
    sort: "due",
    offset: 0,
  })}`;
  const agendaDays = window.weeks
    .flat()
    .filter((date) => (window.view === "week" || inMonth(date, window.anchor)) && byDate.has(date));

  return (
    <>
      <PageHeader title={tTasks("title")} />
      <p className="mb-4 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : tTasks("personalSpace")}</bdi>
      </p>
      <TaskViewSwitch homeId={homeId} current="calendar" list={effective.list} />

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-section-title font-semibold" data-testid="calendar-title">
            {title}
          </h2>
          <nav aria-label={t("navigation")} className="flex flex-wrap items-center gap-2">
            <ul className="flex gap-1" aria-label={t("viewChoice")}>
              {(["week", "month"] as const).map((view) => (
                <li key={view}>
                  <Link
                    href={href({ view, date: window.anchor, day: undefined })}
                    aria-current={window.view === view ? "page" : undefined}
                    className={cx(
                      "inline-flex min-h-10 items-center rounded-control px-3 text-body font-medium",
                      window.view === view
                        ? "bg-accent-subtle text-fg"
                        : "text-accent-fg underline",
                    )}
                  >
                    {view === "week" ? t("week") : t("month")}
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              href={href({ date: window.previous, day: undefined })}
              className="inline-flex min-h-10 items-center px-2 text-body font-medium text-accent-fg underline"
            >
              {window.view === "week" ? t("previousWeek") : t("previousMonth")}
            </Link>
            <Link
              href={href({ date: undefined, day: undefined })}
              className="inline-flex min-h-10 items-center px-2 text-body font-medium text-accent-fg underline"
            >
              {t("today")}
            </Link>
            <Link
              href={href({ date: window.next, day: undefined })}
              className="inline-flex min-h-10 items-center px-2 text-body font-medium text-accent-fg underline"
            >
              {window.view === "week" ? t("nextWeek") : t("nextMonth")}
            </Link>
          </nav>
        </div>

        <CalendarFilters
          action={base}
          query={effective}
          window={window}
          lists={lists.value.filter((list) => !list.archived || list.id === effective.list)}
          labels={labelOptions}
          members={members.value}
          isHome={homeId !== null}
        />

        {query.list && !current ? (
          <p className="text-body text-warning" role="status">
            {t("listUnavailable")}
          </p>
        ) : null}

        {calendar.value.truncated ? (
          <p className="text-body text-warning" role="status">
            {t("truncated")}
          </p>
        ) : null}

        {/* Small screens get an agenda of the days with tasks instead of the grid. */}
        <div className="sm:hidden" data-testid="calendar-agenda">
          {agendaDays.length === 0 ? (
            <p className="text-body text-fg-muted">{t("agendaEmpty")}</p>
          ) : (
            <ol className="flex flex-col gap-3" aria-label={t("agendaLabel", { range: title })}>
              {agendaDays.map((date) => {
                const entries = byDate.get(date) ?? [];
                return (
                  <li key={date} className="flex flex-col gap-1 border-b border-line pb-2">
                    <Link
                      href={href({ date: window.anchor, day: date })}
                      aria-current={date === today ? "date" : undefined}
                      className="font-semibold text-fg underline-offset-2 hover:underline"
                    >
                      {dateText(date)}
                      {date === today ? ` · ${t("todayMarker")}` : ""}
                      {date === selected ? ` · ${t("selectedMarker")}` : ""}
                    </Link>
                    <ul className="flex flex-col gap-0.5">
                      {entries.map((entry, index) => (
                        <li
                          key={`${entry.kind}:${entry.role}:${entry.taskId ?? entry.title}:${String(index)}`}
                          className={cx(
                            "text-body",
                            entry.kind === "task" && entry.completed
                              ? "text-fg-muted line-through"
                              : "text-fg",
                          )}
                        >
                          <bdi>{entry.title}</bdi>
                          {marker(entry).length > 0 ? (
                            <span className="text-helper text-fg-muted">
                              {" "}
                              · {marker(entry).join(" · ")}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="hidden overflow-x-auto sm:block">
          <table
            className="w-full min-w-[42rem] table-fixed border-collapse"
            data-testid="task-calendar"
          >
            <caption className="sr-only">{t("tableCaption", { range: title })}</caption>
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
              {window.weeks.map((week) => (
                <tr key={week[0]}>
                  {week.map((date) => {
                    const entries = byDate.get(date) ?? [];
                    const shown =
                      window.view === "month" ? entries.slice(0, MONTH_CELL_ENTRIES) : entries;
                    const outside = window.view === "month" && !inMonth(date, window.anchor);
                    const isSelected = date === selected;
                    return (
                      <td
                        key={date}
                        className={cx(
                          "h-28 border border-line p-1 align-top",
                          outside && "bg-page",
                          isSelected && "outline outline-2 -outline-offset-2 outline-accent",
                        )}
                        data-testid="calendar-day"
                        data-date={date}
                      >
                        <Link
                          href={href({ date: window.anchor, day: date })}
                          aria-current={date === today ? "date" : undefined}
                          aria-label={[
                            dateText(date),
                            date === today ? t("todayMarker") : null,
                            isSelected ? t("selectedMarker") : null,
                            t("dayCount", { count: entries.length }),
                          ]
                            .filter(Boolean)
                            .join(", ")}
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
                          <ul className="mt-1 flex flex-col gap-0.5" aria-hidden="true">
                            {shown.map((entry, index) => (
                              <li
                                key={`${entry.kind}:${entry.role}:${entry.taskId ?? entry.title}:${String(index)}`}
                                className={cx(
                                  "truncate text-helper",
                                  entry.kind === "task" && entry.completed
                                    ? "text-fg-muted line-through"
                                    : "text-fg",
                                )}
                              >
                                <bdi>{entry.title}</bdi>
                                {marker(entry).length > 0 ? (
                                  <span className="text-fg-muted">
                                    {" "}
                                    · {marker(entry).join(" · ")}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                            {entries.length > shown.length ? (
                              <li className="text-helper text-fg-muted">
                                {t("more", { count: entries.length - shown.length })}
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-body text-fg-muted" data-testid="calendar-undated">
          {calendar.value.undated > 0 ? (
            <>
              {t("undated", { count: calendar.value.undated })}{" "}
              <Link href={undatedHref} className="font-medium text-accent-fg underline">
                {t("undatedLink")}
              </Link>
            </>
          ) : (
            t("undatedNone")
          )}
        </p>

        {selected ? (
          <DayPanel
            homeId={homeId}
            date={selected}
            dateText={dateText(selected)}
            entries={byDate.get(selected) ?? []}
            today={today}
            labels={labelOptions}
            members={members.value}
            formats={formats}
            showListName={!effective.list}
          />
        ) : (
          <p className="text-body text-fg-muted">{t("selectDay")}</p>
        )}
      </div>
    </>
  );
}

async function DayPanel({
  homeId,
  date,
  dateText,
  entries,
  today,
  labels,
  members,
  formats,
  showListName,
}: {
  readonly homeId: string | null;
  readonly date: string;
  readonly dateText: string;
  readonly entries: readonly CalendarEntry[];
  readonly today: string;
  readonly labels: readonly LabelOption[];
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  readonly showListName: boolean;
}) {
  const t = await getTranslations("TaskCalendar");
  const seen = new Set<string>();
  const rows: TaskRow[] = [];
  for (const entry of entries) {
    if (entry.kind !== "task" || seen.has(entry.taskId)) continue;
    seen.add(entry.taskId);
    const { taskId, kind: _kind, role: _role, date: _date, ...rest } = entry;
    rows.push({
      ...rest,
      id: taskId,
      commentCount: 0,
      assignedToMe: false,
      upcoming: !entry.completed && entry.startDate !== null && entry.startDate > today,
    });
  }
  const planned = entries.filter((entry) => entry.kind === "planned");
  const headingId = `calendar-day-${date}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      data-testid="calendar-day-panel"
    >
      <h2 id={headingId} className="text-section-title font-semibold">
        {t("dayHeading", { date: dateText })}
      </h2>
      {rows.length === 0 && planned.length === 0 ? (
        <p className="text-body text-fg-muted">{t("dayEmpty")}</p>
      ) : null}
      {rows.length > 0 ? (
        <CompactTaskList
          homeId={homeId}
          rows={rows}
          labels={labels}
          members={members}
          dateFormat={formats.dateFormat}
          showListName={showListName}
          scope={`calendar:${homeId ?? "personal"}`}
          loadedAt={new Date().toISOString()}
          testId="calendar-day-tasks"
        />
      ) : null}
      {planned.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-body font-semibold">{t("plannedHeading")}</h3>
          <p className="text-helper text-fg-muted">{t("plannedHelp")}</p>
          <ul className="flex flex-col gap-1" data-testid="calendar-day-planned">
            {planned.map((entry, index) => (
              <li key={`${entry.listId}:${entry.title}:${entry.taskId ?? ""}:${String(index)}`}>
                {entry.taskId ? (
                  <Link
                    href={`${tasksPath(homeId)}/${entry.taskId}`}
                    className="font-medium text-fg underline-offset-2 hover:underline"
                  >
                    <bdi>{entry.title}</bdi>
                  </Link>
                ) : (
                  <bdi className="font-medium">{entry.title}</bdi>
                )}
                <span className="text-helper text-fg-muted">
                  {" "}
                  · {t("markerPlanned")}
                  {showListName ? (
                    <>
                      {" · "}
                      <bdi>{entry.listName}</bdi>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

async function CalendarFilters({
  action,
  query,
  window,
  lists,
  labels,
  members,
  isHome,
}: {
  readonly action: string;
  readonly query: CalendarQuery;
  readonly window: ReturnType<typeof calendarWindow>;
  readonly lists: readonly { id: string; name: string; archived: boolean }[];
  readonly labels: readonly { id: string; name: string }[];
  readonly members: readonly { id: string; name: string | null; isSelf: boolean }[];
  readonly isHome: boolean;
}) {
  const [t, tTasks] = await Promise.all([
    getTranslations("TaskCalendar"),
    getTranslations("Tasks"),
  ]);
  const priorityKey = {
    low: "priorityLow",
    normal: "priorityNormal",
    high: "priorityHigh",
    urgent: "priorityUrgent",
  } as const;
  const clear = calendarQueryString(
    { ...query, status: "all", priority: [], label: [], assignee: "any", member: undefined },
    { day: undefined },
  );
  return (
    <form
      method="get"
      action={action}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      aria-label={tTasks("filtersLabel")}
      data-testid="calendar-filters"
    >
      {window.view !== "month" ? <input type="hidden" name="view" value={window.view} /> : null}
      <input type="hidden" name="date" value={window.anchor} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          label={t("filterList")}
          name="list"
          defaultValue={query.list ?? ""}
          options={[
            { value: "", label: tTasks("allTasks") },
            ...lists.map((list) => ({ value: list.id, label: list.name })),
          ]}
        />
        <SelectField
          label={tTasks("filterStatus")}
          name="status"
          defaultValue={query.status}
          options={[
            { value: "all", label: tTasks("statusFilterAll") },
            { value: "open", label: tTasks("statusFilterOpen") },
            { value: "completed", label: tTasks("statusFilterCompleted") },
          ]}
        />
        {isHome ? (
          <SelectField
            label={tTasks("filterAssignee")}
            name="assignee"
            defaultValue={
              query.assignee === "member" && query.member ? query.member : query.assignee
            }
            options={[
              { value: "any", label: tTasks("assigneeAny") },
              { value: "me", label: tTasks("assigneeMe") },
              { value: "unassigned", label: tTasks("assigneeUnassigned") },
              { value: "needs_reassignment", label: tTasks("assigneeNeedsReassignment") },
              ...members
                .filter((member) => !member.isSelf)
                .map((member) => ({
                  value: member.id,
                  label: member.name ?? tTasks("personUnnamed"),
                })),
            ]}
          />
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-fg">{tTasks("filterPriority")}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {[...taskPriorities, "unset" as const].map((value) => (
            <Checkbox
              key={value}
              name="priority"
              value={value}
              label={value === "unset" ? tTasks("priorityUnset") : tTasks(priorityKey[value])}
              defaultChecked={query.priority.includes(value)}
            />
          ))}
        </div>
      </fieldset>
      {labels.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium text-fg">{tTasks("filterLabels")}</legend>
          <p className="text-helper text-fg-muted">{tTasks("filterLabelsHelp")}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {labels.map((label) => (
              <Checkbox
                key={label.id}
                name="label"
                value={label.id}
                label={label.name}
                defaultChecked={query.label.includes(label.id)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary">
          {tTasks("applyFilters")}
        </Button>
        {hasCalendarFilters(query) ? (
          <Link
            href={clear ? `${action}?${clear}` : action}
            className="text-body font-medium text-accent-fg underline"
          >
            {tTasks("clearFilters")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
