"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { goalEndpoint, sendGoalRequest, type GoalDetail } from "@/goals/api";
import { goalKeys, goalSeriesPath, goalsPath } from "@/goals/format";
import { memberNames, type MemberOption } from "@/tasks/format";

import {
  DeleteDialog,
  Failure,
  ProgressDialog,
  ReopenDialog,
  RemindersDialog,
  TargetDialog,
} from "./goal-dialogs";
import { GoalFormDialog, type GoalContextOption, type GoalFormMode } from "./goal-form-dialog";
import { GoalEntriesList, GoalEventsList } from "./goal-history";
import { GoalProgressMeter, GoalStatusLabel } from "./goal-progress";
import { useGoalMutation } from "./use-goal-mutation";
import { useGoalTexts } from "./use-goal-texts";

/** Read again this often while the page is visible (no Realtime for goals). */
const REFRESH_INTERVAL_MS = 60_000;

type DialogKind =
  | { readonly kind: "add" | "total" | "target" | "reminders" | "reopen" | "delete" }
  | { readonly kind: "form"; readonly mode: GoalFormMode };

export interface GoalDetailViewProps {
  readonly initialGoal: GoalDetail;
  readonly members: readonly MemberOption[];
  /** Where a renewed goal can go: the Personal space and the person's Homes. */
  readonly contexts: readonly GoalContextOption[];
  /** The viewer's effective timezone and the zones to offer for personal goals. */
  readonly timeZone: string;
  readonly timeZones: readonly string[];
}

/** Reads the goal again on focus, every minute and after each change. */
function useGoalDetail(initial: GoalDetail): GoalDetail {
  const query = useQuery<{ goal: GoalDetail }>({
    queryKey: goalKeys.detail(initial.id),
    queryFn: () => sendGoalRequest("GET", goalEndpoint(initial.id)),
    initialData: { goal: initial },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  return query.data.goal;
}

/**
 * One goal's page (S30): its status, progress against the target (uncapped numbers, a bar capped at
 * 100%), Target reached with Mark achieved, Add progress and Set total, the contributions with their
 * corrections, the achievement history, the change log, and the changes the viewer may make. Every
 * change is checked again by the database. A period of a recurring series (S30b) shows its dates and
 * series, and once it ended its calculated outcome; its target changes from the series.
 */
export function GoalDetailView({
  initialGoal,
  members,
  contexts,
  timeZone,
  timeZones,
}: GoalDetailViewProps) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const goal = useGoalDetail(initialGoal);
  const names = memberNames(members);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const close = () => {
    setDialog(null);
  };
  const achieve = useGoalMutation(`goal:${goal.id}`, () =>
    sendGoalRequest("POST", goalEndpoint(goal.id, "achievement"), {
      revision: goal.revision,
      achieved: true,
    }),
  );
  const archive = useGoalMutation(`goal:${goal.id}`, (archived: boolean) =>
    sendGoalRequest("POST", goalEndpoint(goal.id, "archive"), {
      revision: goal.revision,
      archived,
    }),
  );
  const myReminders = useGoalMutation(`goal-my-reminders:${goal.id}`, (enabled: boolean) =>
    sendGoalRequest("PUT", goalEndpoint(goal.id, "my-reminders"), { enabled }),
  );
  const { actions } = goal;
  const archived = goal.status === "archived";
  const achieved = goal.status === "achieved";
  const measurable = goal.kind === "measurable";
  return (
    <div className="flex flex-col gap-8" data-testid="goal-detail">
      <div className="flex flex-col gap-2">
        <PageHeader title={goal.title} />
        <p className="flex flex-wrap items-center gap-2 text-body text-fg">
          <GoalStatusLabel goal={goal} />
          <span>{measurable ? t("kindMeasurable") : t("kindCompletion")}</span>
          {goal.deadline ? (
            <span data-testid="goal-deadline-line">
              · {t("deadlineLine", { date: texts.date(goal.deadline, "short") })}
            </span>
          ) : null}
        </p>
        {goal.period ? (
          <p className="text-body text-fg" data-testid="goal-period-line">
            {t("periodLine", {
              period: texts.period(goal.period.start, goal.period.end),
              frequency: texts.frequency(goal.period.frequency),
            })}{" "}
            <Link
              href={goalSeriesPath(goal.homeId, goal.period.seriesId)}
              className="text-accent-fg underline"
            >
              <bdi>{goal.period.seriesTitle}</bdi>
            </Link>
          </p>
        ) : null}
        {goal.description ? (
          <p className="max-w-prose whitespace-pre-line text-body text-fg-muted">
            <bdi>{goal.description}</bdi>
          </p>
        ) : null}
        {goal.renewedFrom ? (
          <p className="text-helper text-fg-muted">
            {t("renewedFrom")}{" "}
            <Link
              href={goalsPath(goal.homeId, goal.renewedFrom.id)}
              className="text-accent-fg underline"
            >
              <bdi>{goal.renewedFrom.title}</bdi>
            </Link>
          </p>
        ) : null}
        {goal.homeId === null ? (
          <p className="text-helper text-fg-muted">{t("zoneLine", { zone: goal.timeZone })}</p>
        ) : null}
      </div>

      <section aria-labelledby="goal-progress-heading" className="flex max-w-xl flex-col gap-3">
        <h2 id="goal-progress-heading" className="text-section-title font-semibold">
          {t("progressTitle")}
        </h2>
        {measurable ? <GoalProgressMeter goal={goal} /> : null}
        {goal.period?.outcome ? (
          <p className="text-body font-medium text-fg" data-testid="goal-period-outcome">
            {t("outcomeLine", { outcome: texts.outcome(goal.period.outcome) })}
            {goal.period.correctedAt ? ` · ${t("outcomeCorrected")}` : ""}
          </p>
        ) : null}
        {goal.period?.ended && !archived ? (
          <p className="text-helper text-fg-muted">
            {actions.manage ? t("periodEndedManage") : t("periodEndedView")}
          </p>
        ) : null}
        {goal.period?.needsReview ? (
          <p className="text-body text-fg" role="note" data-testid="goal-needs-review">
            {t("needsReview")}
          </p>
        ) : null}
        {achieved && goal.achievedAt ? (
          <p className="text-body font-medium text-fg" data-testid="goal-achieved-line">
            {t("achievedLine", {
              person: texts.who(goal.achievedBy, goal.achievedByMe, names),
              at: texts.instant(goal.achievedAt, goal.timeZone),
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {actions.contribute ? (
            <Button
              onClick={() => {
                setDialog({ kind: "add" });
              }}
              data-testid="goal-add-progress"
            >
              {t("addProgress")}
            </Button>
          ) : null}
          {actions.achieve ? (
            <Button
              loading={achieve.busy}
              onClick={() => {
                achieve.mutate(undefined);
              }}
              data-testid="goal-achieve"
            >
              {t("markAchieved")}
            </Button>
          ) : null}
          {actions.setTotal ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDialog({ kind: "total" });
              }}
              data-testid="goal-set-total"
            >
              {t("setTotal")}
            </Button>
          ) : null}
          {actions.reopen ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDialog({ kind: "reopen" });
              }}
              data-testid="goal-reopen"
            >
              {t("reopen")}
            </Button>
          ) : null}
          {achieved ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDialog({ kind: "form", mode: { kind: "renew", goal } });
              }}
              data-testid="goal-renew"
            >
              {t("renew")}
            </Button>
          ) : null}
        </div>
        <Failure error={achieve.error} />
      </section>

      {measurable ? <GoalEntriesList goal={goal} names={names} /> : null}

      {goal.achievements.length > 0 ? (
        <section aria-labelledby="goal-achievements-heading" className="flex flex-col gap-2">
          <h2 id="goal-achievements-heading" className="text-section-title font-semibold">
            {t("achievementsTitle")}
          </h2>
          <ul className="flex flex-col gap-1 text-body text-fg" data-testid="goal-achievements">
            {goal.achievements.map((achievement) => (
              <li key={achievement.id}>
                {t("achievementLine", {
                  person: texts.who(achievement.by, achievement.mine, names),
                  at: texts.instant(achievement.achievedAt, goal.timeZone),
                })}
                {measurable && achievement.target !== null && achievement.total !== null
                  ? ` · ${texts.progress({
                      total: achievement.total,
                      target: achievement.target,
                      unit: achievement.unit,
                      unitKind: achievement.unitKind,
                    })}`
                  : ""}
                {achievement.reopenedAt ? (
                  <span className="text-fg-muted">
                    {" · "}
                    {t("reopenedLine", {
                      person: texts.who(achievement.reopenedBy, achievement.reopenedByMe, names),
                      at: texts.instant(achievement.reopenedAt, goal.timeZone),
                    })}
                    {achievement.reason ? (
                      <>
                        {" · "}
                        {t("reasonLine")} <bdi>{achievement.reason}</bdi>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="goal-reminders-heading" className="flex max-w-xl flex-col gap-2">
        <h2 id="goal-reminders-heading" className="text-section-title font-semibold">
          {t("remindersTitle")}
        </h2>
        <p className="text-body text-fg" data-testid="goal-reminders-state">
          {goal.reminder?.enabled
            ? t("remindersOn", {
                parts: new Intl.ListFormat(texts.locale, { type: "conjunction" }).format([
                  ...(goal.reminder.leadDays === null
                    ? []
                    : [t("remindersLeadPart", { count: goal.reminder.leadDays })]),
                  ...(goal.reminder.overdueDays === null
                    ? []
                    : [t("remindersOverduePart", { count: goal.reminder.overdueDays })]),
                ]),
                time: goal.reminder.atTime,
              })
            : t("remindersOff")}
        </p>
        {goal.reminder?.enabled
          ? goal.reminder.moments
              .filter((moment) => !moment.passed)
              .slice(0, 1)
              .map((moment) => (
                <p key={moment.kind} className="text-helper text-fg-muted">
                  {t("remindersNext", { at: texts.instant(moment.at, goal.timeZone) })}
                </p>
              ))
          : null}
        {goal.homeId !== null ? (
          <Checkbox
            label={t("myRemindersLabel")}
            description={t("myRemindersHint")}
            checked={goal.myReminders}
            disabled={myReminders.busy}
            onChange={(event) => {
              myReminders.mutate(event.target.checked);
            }}
            data-testid="goal-my-reminders"
          />
        ) : null}
        <Failure error={myReminders.error} />
      </section>

      {actions.manage ? (
        <section aria-labelledby="goal-manage-heading" className="flex flex-col gap-2">
          <h2 id="goal-manage-heading" className="text-section-title font-semibold">
            {t("manageTitle")}
          </h2>
          <div className="flex flex-wrap gap-2">
            {archived ? null : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDialog({ kind: "form", mode: { kind: "edit", goal } });
                  }}
                  data-testid="goal-edit"
                >
                  {t("edit")}
                </Button>
                {measurable && !goal.period ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDialog({ kind: "target" });
                    }}
                    data-testid="goal-change-target"
                  >
                    {achieved ? t("increaseTarget") : t("changeTarget")}
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDialog({ kind: "reminders" });
                  }}
                  data-testid="goal-reminders"
                >
                  {t("remindersEdit")}
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              loading={archive.busy}
              onClick={() => {
                archive.mutate(!archived);
              }}
              data-testid="goal-archive"
            >
              {archived ? t("unarchive") : t("archive")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDialog({ kind: "delete" });
              }}
              data-testid="goal-delete"
            >
              {t("delete")}
            </Button>
          </div>
          <Failure error={archive.error} />
        </section>
      ) : null}

      <GoalEventsList goal={goal} names={names} />

      {dialog?.kind === "add" || dialog?.kind === "total" ? (
        <ProgressDialog goal={goal} mode={dialog.kind} onClose={close} />
      ) : null}
      {dialog?.kind === "target" ? (
        <TargetDialog
          goal={goal}
          onClose={close}
          onFollowUp={(target) => {
            setDialog({ kind: "form", mode: { kind: "renew", goal, target: target / 1000 } });
          }}
        />
      ) : null}
      {dialog?.kind === "reminders" ? <RemindersDialog goal={goal} onClose={close} /> : null}
      {dialog?.kind === "reopen" ? <ReopenDialog goal={goal} onClose={close} /> : null}
      {dialog?.kind === "delete" ? <DeleteDialog goal={goal} onClose={close} /> : null}
      {dialog?.kind === "form" ? (
        <GoalFormDialog
          mode={dialog.mode}
          contexts={contexts}
          today={goal.today}
          timeZone={timeZone}
          timeZones={timeZones}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
