"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import type { GoalView, GoalWeekStart } from "@madeora/domain/goals";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { EmptyState } from "@/components/ui/states";
import {
  GOAL_SETTINGS_ENDPOINT,
  GOALS_ENDPOINT,
  sendGoalRequest,
  type GoalList,
  type GoalSeriesSummary,
  type GoalSummary,
} from "@/goals/api";
import { goalKeys, goalSeriesPath, goalsPath } from "@/goals/format";

import { Failure } from "./goal-dialogs";
import { GoalFormDialog } from "./goal-form-dialog";
import { GoalProgressMeter, GoalStatusLabel } from "./goal-progress";
import { useGoalMutation } from "./use-goal-mutation";
import { useGoalTexts } from "./use-goal-texts";

/** Read again this often while the page is visible (no Realtime for goals). */
const REFRESH_INTERVAL_MS = 60_000;

export interface GoalsViewProps {
  readonly homeId: string | null;
  readonly view: GoalView;
  readonly query: string;
  readonly initialList: GoalList;
  /** The context's today (the Home's timezone, or the viewer's). */
  readonly today: string;
  readonly timeZone: string;
  readonly timeZones: readonly string[];
  /** The viewer's week start, the default for a weekly series. */
  readonly weekStart: GoalWeekStart;
}

/** Reads the list again on focus, every minute and after each change. */
function useGoalList(homeId: string | null, view: GoalView, query: string, initial: GoalList) {
  const result = useQuery<{ list: GoalList }>({
    queryKey: [...goalKeys.list(homeId, view), query],
    queryFn: () => {
      const search = new URLSearchParams({ view });
      if (homeId) search.set("homeId", homeId);
      if (query) search.set("q", query);
      return sendGoalRequest("GET", `${GOALS_ENDPOINT}?${search.toString()}`);
    },
    initialData: { list: initial },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  return result.data.list;
}

/**
 * The goals of one context (S30): the active ones (an Overdue label where the deadline passed), the
 * Completed ones and the Archived ones, searchable by title. Goal managers create goals here and, in
 * a Home, set whether members contribute or only view. Recurring series (S30b) are listed in their
 * own section; their running periods are among the active goals.
 */
export function GoalsView({
  homeId,
  view,
  query,
  initialList,
  today,
  timeZone,
  timeZones,
  weekStart,
}: GoalsViewProps) {
  const t = useTranslations("Goals");
  const list = useGoalList(homeId, view, query, initialList);
  const [creating, setCreating] = useState(false);
  const base = goalsPath(homeId);
  const views = [
    { view: "active", label: t("viewActive", { count: list.counts.active }) },
    { view: "completed", label: t("viewCompleted", { count: list.counts.completed }) },
    { view: "archived", label: t("viewArchived", { count: list.counts.archived }) },
  ] as const;
  return (
    <div className="flex flex-col gap-6" data-testid="goals-view">
      <nav aria-label={t("viewsLabel")}>
        <ul className="flex flex-wrap gap-2">
          {views.map((item) => (
            <li key={item.view}>
              <Link
                href={item.view === "active" ? base : `${base}?view=${item.view}`}
                aria-current={item.view === view ? "page" : undefined}
                className={
                  item.view === view
                    ? "inline-flex min-h-10 items-center rounded-control bg-accent-subtle px-3 text-body font-semibold text-fg"
                    : "inline-flex min-h-10 items-center rounded-control px-3 text-body text-accent-fg underline"
                }
                data-testid={`goals-view-${item.view}`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {view !== "active" ? (
        <form method="get" action={base} role="search" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="view" value={view} />
          <label className="flex flex-col gap-1.5 text-body font-medium text-fg">
            {t("searchLabel")}
            <input
              type="search"
              name="q"
              defaultValue={query}
              maxLength={80}
              className="min-h-10 rounded-control border border-line-control bg-surface px-3 text-body text-fg"
              data-testid="goals-search"
            />
          </label>
          <Button type="submit" variant="secondary">
            {t("search")}
          </Button>
        </form>
      ) : null}
      {view === "active" && list.access === "manage" ? (
        <div>
          <Button
            onClick={() => {
              setCreating(true);
            }}
            data-testid="goal-new"
          >
            {t("newGoal")}
          </Button>
        </div>
      ) : null}
      {list.goals.length === 0 ? (
        <EmptyState
          title={
            query
              ? t("emptySearch")
              : view === "active"
                ? t("emptyActive")
                : view === "completed"
                  ? t("emptyCompleted")
                  : t("emptyArchived")
          }
          description={
            view === "active" && !query
              ? list.access === "manage"
                ? t("emptyActiveManage")
                : t("emptyActiveView")
              : undefined
          }
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="goal-list">
          {list.goals.map((goal) => (
            <li key={goal.id}>
              <GoalCard goal={goal} />
            </li>
          ))}
        </ul>
      )}
      {view === "active" && list.series.length > 0 ? (
        <section aria-labelledby="goal-series-heading" className="flex flex-col gap-3">
          <h2 id="goal-series-heading" className="text-section-title font-semibold">
            {t("seriesTitle")}
          </h2>
          <ul className="grid gap-3 md:grid-cols-2" data-testid="goal-series-list">
            {list.series.map((series) => (
              <li key={series.id}>
                <SeriesCard series={series} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {homeId && list.memberAccess ? <GoalSettings homeId={homeId} list={list} /> : null}
      {creating ? (
        <GoalFormDialog
          mode={{ kind: "create", homeId }}
          contexts={[]}
          today={today}
          timeZone={timeZone}
          timeZones={timeZones}
          weekStart={weekStart}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
    </div>
  );
}

function GoalCard({ goal }: { readonly goal: GoalSummary }) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const headingId = `goal-${goal.id}-title`;
  return (
    <article
      aria-labelledby={headingId}
      className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-4"
      data-testid="goal-card"
    >
      <h2 id={headingId} className="text-section-title font-semibold text-fg">
        <Link href={goalsPath(goal.homeId, goal.id)} className="underline-offset-4 hover:underline">
          <bdi>{goal.title}</bdi>
        </Link>
      </h2>
      <p className="flex flex-wrap items-center gap-2 text-helper text-fg-muted">
        <GoalStatusLabel goal={goal} />
        {goal.period ? (
          <span className="inline-flex items-center rounded-full border border-line px-2 font-medium text-fg">
            {texts.frequency(goal.period.frequency)}
          </span>
        ) : null}
        {goal.deadline ? (
          <span>{t("deadlineLine", { date: texts.date(goal.deadline, "short") })}</span>
        ) : null}
      </p>
      {goal.kind === "measurable" ? (
        <GoalProgressMeter goal={goal} compact />
      ) : (
        <p className="text-body text-fg">
          {goal.status === "achieved" ? t("completionDone") : t("completionOpen")}
        </p>
      )}
    </article>
  );
}

/** A recurring series: how it repeats, its state and the period running now. */
function SeriesCard({ series }: { readonly series: GoalSeriesSummary }) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const headingId = `goal-series-${series.id}-title`;
  return (
    <article
      aria-labelledby={headingId}
      className="flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-4"
      data-testid="goal-series-card"
    >
      <h3 id={headingId} className="text-section-title font-semibold text-fg">
        <Link
          href={goalSeriesPath(series.homeId, series.id)}
          className="underline-offset-4 hover:underline"
        >
          <bdi>{series.title}</bdi>
        </Link>
      </h3>
      <p className="text-helper text-fg-muted">
        {t("seriesLine", {
          frequency: texts.frequency(series.frequency),
          state: texts.seriesState(series.state),
        })}
      </p>
      <p className="text-body text-fg">
        {series.current
          ? t("seriesCurrentLine", {
              period: texts.period(series.current.start, series.current.end),
              progress:
                series.kind === "measurable"
                  ? texts.progress(series.current)
                  : texts.status(series.current.status),
            })
          : t("seriesNoCurrent")}
      </p>
    </article>
  );
}

/** For goal managers of a Home: whether members contribute or only view; others see which. */
function GoalSettings({ homeId, list }: { readonly homeId: string; readonly list: GoalList }) {
  const t = useTranslations("Goals");
  const access = useGoalMutation("goal-member-access", (memberAccess: string) =>
    sendGoalRequest("PATCH", GOAL_SETTINGS_ENDPOINT, { homeId, memberAccess }),
  );
  return (
    <section aria-labelledby="goal-settings-heading" className="flex max-w-xl flex-col gap-3">
      <h2 id="goal-settings-heading" className="text-section-title font-semibold">
        {t("settingsTitle")}
      </h2>
      {list.access === "manage" ? (
        <SelectField
          label={t("memberAccessLabel")}
          description={t("memberAccessHint")}
          value={list.memberAccess ?? "contribute"}
          disabled={access.busy}
          onChange={(event) => {
            access.mutate(event.target.value);
          }}
          options={[
            { value: "contribute", label: t("memberAccessContribute") },
            { value: "view", label: t("memberAccessView") },
          ]}
          data-testid="goal-member-access"
        />
      ) : (
        <p className="text-body text-fg-muted">
          {list.memberAccess === "view" ? t("membersView") : t("membersContribute")}
        </p>
      )}
      <Failure error={access.error} />
    </section>
  );
}
