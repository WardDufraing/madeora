"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  goalEndpoint,
  GOALS_ENDPOINT,
  sendGoalRequest,
  type GoalDetail,
  type GoalList,
  type GoalSummary,
} from "@/goals/api";
import { goalKeys, goalsPath } from "@/goals/format";

import { Failure } from "./goal-dialogs";
import { GoalProgressMeter, GoalStatusLabel, ProgressForm } from "./goal-progress";
import { useGoalMutation } from "./use-goal-mutation";

/** Read again this often while the dashboard is visible (no Realtime for goals). */
const REFRESH_INTERVAL_MS = 60_000;

type WidgetHome = { readonly id: string; readonly name: string } | null;

/**
 * One goal in a widget: its progress and status, the compact Add progress editor (current value,
 * target, unit, amount, resulting total and the Home) and Mark achieved for a completion goal, each
 * only where the database says the viewer may; read-only otherwise.
 */
function GoalWidgetItem({ goal, home }: { readonly goal: GoalSummary; readonly home: WidgetHome }) {
  const t = useTranslations("Goals");
  const [adding, setAdding] = useState(false);
  const achieve = useGoalMutation(`goal:${goal.id}`, () =>
    sendGoalRequest("POST", goalEndpoint(goal.id, "achievement"), {
      revision: goal.revision,
      achieved: true,
    }),
  );
  return (
    <div className="flex flex-col gap-2" data-testid="goal-widget-item">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={goalsPath(goal.homeId, goal.id)}
          className="text-body font-medium text-fg underline-offset-4 hover:underline"
        >
          <bdi>{goal.title}</bdi>
        </Link>
        <GoalStatusLabel goal={goal} />
      </div>
      {goal.kind === "measurable" ? <GoalProgressMeter goal={goal} compact /> : null}
      {goal.actions.contribute && !adding ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("addProgressTo", { goal: goal.title })}
            onClick={() => {
              setAdding(true);
            }}
            data-testid="goal-widget-add"
          >
            {t("addProgress")}
          </Button>
        </div>
      ) : null}
      {adding ? (
        <ProgressForm
          goal={goal}
          mode="add"
          source="widget"
          homeName={home?.name ?? null}
          compact
          onDone={() => {
            setAdding(false);
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      ) : null}
      {goal.kind === "completion" && goal.actions.achieve ? (
        <div>
          <Button
            size="sm"
            loading={achieve.busy}
            aria-label={t("markAchievedGoal", { goal: goal.title })}
            onClick={() => {
              achieve.mutate(undefined);
            }}
            data-testid="goal-widget-achieve"
          >
            {t("markAchieved")}
          </Button>
        </div>
      ) : null}
      <Failure error={achieve.error} />
    </div>
  );
}

/** The Goals widget's body: the context's active goals, read again every minute. */
export function GoalsWidgetBody({
  home,
  initialList,
  count,
}: {
  readonly home: WidgetHome;
  readonly initialList: GoalList;
  readonly count: number;
}) {
  const t = useTranslations("Goals");
  const homeId = home?.id ?? null;
  const query = useQuery<{ list: GoalList }>({
    queryKey: [...goalKeys.list(homeId, "active"), "widget"],
    queryFn: () => {
      const search = new URLSearchParams({ view: "active" });
      if (homeId) search.set("homeId", homeId);
      return sendGoalRequest("GET", `${GOALS_ENDPOINT}?${search.toString()}`);
    },
    initialData: { list: initialList },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const goals = query.data.list.goals.slice(0, count);
  if (goals.length === 0) {
    return <p className="text-body text-fg-muted">{t("widgetEmpty")}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-4" data-testid="goals-widget">
        {goals.map((goal) => (
          <li key={goal.id}>
            <GoalWidgetItem goal={goal} home={home} />
          </li>
        ))}
      </ul>
      <Link href={goalsPath(homeId)} className="text-helper text-accent-fg underline">
        {t("widgetAll")}
      </Link>
    </div>
  );
}

/** The Goal progress widget's body: one goal, kept showing with "Achieved" once it is achieved. */
export function GoalProgressWidgetBody({
  home,
  initialGoal,
}: {
  readonly home: WidgetHome;
  readonly initialGoal: GoalDetail;
}) {
  const query = useQuery<{ goal: GoalDetail }>({
    queryKey: [...goalKeys.detail(initialGoal.id), "widget"],
    queryFn: () => sendGoalRequest("GET", goalEndpoint(initialGoal.id)),
    initialData: { goal: initialGoal },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  return (
    <div data-testid="goal-progress-widget">
      <GoalWidgetItem goal={query.data.goal} home={home} />
    </div>
  );
}
