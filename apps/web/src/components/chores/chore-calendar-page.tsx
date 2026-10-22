import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { SelectField } from "@/components/ui/select-field";
import { ErrorState } from "@/components/ui/states";
import {
  choreCalendarQueryString,
  filterAgenda,
  parseChoreCalendarQuery,
  type ChoreCalendarQuery,
} from "@/chores/calendar";
import {
  advanceChores,
  getChoreContext,
  listChoreCategories,
  listChoreSchedule,
} from "@/chores/data";
import { choresPath } from "@/chores/format";
import { getDateTimeFormats } from "@/invitations/server";
import { weekdayNames } from "@/preferences/regional";
import { getRegionalFormats } from "@/preferences/server";
import { calendarWindow } from "@/tasks/calendar";
import { listVacationDays } from "@/vacations/data";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate } from "@/tasks/format";

import { ChoreCalendarBoard } from "./chore-calendar-board";

export interface ChoreCalendarPageProps {
  readonly home: { readonly id: string; readonly name: string };
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

const navLink =
  "inline-flex min-h-10 items-center px-2 text-body font-medium text-accent-fg underline";

/**
 * A Home's Chores calendar (S21; spec "Confirmed chore calendar and rescheduling"): a week or month
 * of chores on their due dates in the Home's timezone, with the dates of recurring chores still to
 * come, filtered by member and category. Every member sees it; chore managers move one occurrence
 * at a time from it. The address holds the whole view, so it reads without JavaScript.
 */
export async function ChoreCalendarPage({ home, searchParams }: ChoreCalendarPageProps) {
  const query = parseChoreCalendarQuery(searchParams);
  await advanceChores(home.id);
  const [t, formats, regional, context, categories, members] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getRegionalFormats(),
    getChoreContext(home.id),
    listChoreCategories(home.id, true),
    listTaskMembers(home.id),
  ]);
  if (context.status !== "ok" || categories.status !== "ok" || members.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const today = context.value.today;
  const window = calendarWindow(query.view, query.date ?? today, regional.effective.weekStart);
  const [schedule, vacationDays] = await Promise.all([
    listChoreSchedule(home.id, window.from, window.to),
    // S22: vacation days to mark; a failure only leaves them out.
    listVacationDays(home.id, window.from, window.to),
  ]);
  if (schedule.status !== "ok") {
    return <ErrorState title={t("calendarLoadFailedTitle")} description={t("loadFailed")} />;
  }
  const base = `${choresPath(home.id)}/calendar`;
  const href = (changes: Partial<ChoreCalendarQuery>) => {
    const search = choreCalendarQueryString(query, changes);
    return search ? `${base}?${search}` : base;
  };
  const inWindow = (date: string) => date >= window.from && date <= window.to;
  const selected = query.day && inWindow(query.day) ? query.day : inWindow(today) ? today : null;
  const dateText = (date: string) => formatTaskDate(date, formats);
  const title =
    window.view === "month"
      ? new Intl.DateTimeFormat(formats.locale, {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${window.anchor}T12:00:00Z`))
      : t("calendarWeekRange", { from: dateText(window.from), to: dateText(window.to) });
  const filtered = query.member !== null || query.category !== null;
  const clear = choreCalendarQueryString(query, { member: null, category: null, day: null });

  return (
    <>
      <PageHeader title={t("calendarTitle")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={choresPath(home.id)} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-section-title font-semibold" data-testid="chore-calendar-title">
            {title}
          </h2>
          <nav aria-label={t("calendarNavigation")} className="flex flex-wrap items-center gap-2">
            <ul className="flex gap-1" aria-label={t("calendarViewChoice")}>
              {(["week", "month"] as const).map((view) => (
                <li key={view}>
                  <Link
                    href={href({ view, date: window.anchor, day: null })}
                    aria-current={window.view === view ? "page" : undefined}
                    className={cx(
                      "inline-flex min-h-10 items-center rounded-control px-3 text-body font-medium",
                      window.view === view
                        ? "bg-accent-subtle text-fg"
                        : "text-accent-fg underline",
                    )}
                  >
                    {view === "week" ? t("calendarWeek") : t("calendarMonth")}
                  </Link>
                </li>
              ))}
            </ul>
            <Link href={href({ date: window.previous, day: null })} className={navLink}>
              {window.view === "week" ? t("calendarPreviousWeek") : t("calendarPreviousMonth")}
            </Link>
            <Link href={href({ date: null, day: null })} className={navLink}>
              {t("calendarToday")}
            </Link>
            <Link href={href({ date: window.next, day: null })} className={navLink}>
              {window.view === "week" ? t("calendarNextWeek") : t("calendarNextMonth")}
            </Link>
          </nav>
        </div>

        <form
          method="get"
          action={base}
          className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
          aria-label={t("filtersLabel")}
          data-testid="chore-calendar-filters"
        >
          {window.view !== "week" ? <input type="hidden" name="view" value={window.view} /> : null}
          <input type="hidden" name="date" value={window.anchor} />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t("calendarFilterMember")}
              name="member"
              defaultValue={query.member ?? ""}
              options={[
                { value: "", label: t("calendarAnyone") },
                { value: "unassigned", label: t("unassigned") },
                ...members.value.map((member) => ({
                  value: member.id,
                  label: member.isSelf ? t("personYou") : (member.name ?? t("personUnnamed")),
                })),
              ]}
            />
            <SelectField
              label={t("calendarFilterCategory")}
              name="category"
              defaultValue={query.category ?? ""}
              options={[
                { value: "", label: t("calendarAnyCategory") },
                { value: "none", label: t("calendarNoCategory") },
                ...categories.value
                  .filter((category) => !category.archived || category.id === query.category)
                  .map((category) => ({ value: category.id, label: category.name })),
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary">
              {t("calendarApplyFilters")}
            </Button>
            {filtered ? (
              <Link
                href={clear ? `${base}?${clear}` : base}
                className="text-body font-medium text-accent-fg underline"
              >
                {t("calendarClearFilters")}
              </Link>
            ) : null}
          </div>
        </form>

        {schedule.value.truncated ? (
          <p className="text-body text-warning" role="status">
            {t("calendarTruncated")}
          </p>
        ) : null}

        <ChoreCalendarBoard
          homeId={home.id}
          query={query}
          anchor={window.anchor}
          weeks={window.weeks}
          today={today}
          selected={selected}
          items={filterAgenda(schedule.value.items, query)}
          members={members.value}
          canManage={schedule.value.canManage}
          formats={formats}
          weekdays={weekdayNames(regional.effective.weekStart, formats.locale, "short")}
          weekdaysLong={weekdayNames(regional.effective.weekStart, formats.locale, "long")}
          title={title}
          vacationDays={vacationDays.status === "ok" ? vacationDays.value.days : []}
        />
      </div>
    </>
  );
}
