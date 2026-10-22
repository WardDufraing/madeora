import { targetProgress, type LeaderboardPeriod } from "@madeora/domain/points";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { EmptyState, ErrorState } from "@/components/ui/states";
import { serverPerson } from "@/components/vacations/vacations-page";
import type { DateTimeFormats } from "@/invitations/format";
import { getLeaderboard, getPointSummary, getWeeklyPoints, listRewards } from "@/points/data";
import { leaderboardPath, pointsPath, rewardsPath } from "@/points/format";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames } from "@/tasks/format";

import { LeaderboardRows } from "./leaderboard-page";

function Target({
  earned,
  target,
  label,
}: {
  readonly earned: number;
  readonly target: number | null;
  readonly label: string;
}) {
  const progress = targetProgress(earned, target);
  if (!progress) return null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={progress.target}
      aria-valuenow={Math.max(Math.min(progress.earned, progress.target), 0)}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
    >
      <div
        className="h-full rounded-full bg-accent"
        style={{ width: `${String(Math.round(progress.ratio * 100))}%` }}
      />
    </div>
  );
}

/**
 * The Weekly points widget (S23; spec "Confirmed weekly points dashboard widget"): the viewer's own
 * week (earned, waiting for approval, still possible from their open chores, target progress), or
 * the shared overview of every participating member (shared targets only) with the unassigned
 * chores' possible points as a separate total. Never a ranking.
 */
export async function WeeklyPointsWidget({
  homeId,
  view,
  formats,
}: {
  readonly homeId: string;
  readonly view: "mine" | "shared";
  readonly formats: DateTimeFormats;
}) {
  const [t, data, members] = await Promise.all([
    getTranslations("Points"),
    getWeeklyPoints(homeId, view === "shared"),
    view === "shared" ? listTaskMembers(homeId) : null,
  ]);
  if (
    data.status !== "ok" ||
    members?.status === "unavailable" ||
    members?.status === "not-found"
  ) {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  const week = data.value;
  const range = t("widgetWeekRange", {
    from: formatTaskDate(week.startsOn, formats),
    to: formatTaskDate(week.endsOn, formats),
  });
  const link = (
    <Link href={pointsPath(homeId)} className="text-helper font-medium text-accent-fg underline">
      {t("widgetOpenPoints")}
    </Link>
  );
  if (view === "mine" || !week.members || members?.status !== "ok") {
    return (
      <div className="flex flex-col gap-2 text-body text-fg" data-testid="weekly-points-widget">
        <p className="text-helper text-fg-muted">{range}</p>
        <p className="text-section-title font-semibold" data-testid="weekly-points-earned">
          {t("widgetEarned", { points: week.me.earned })}
        </p>
        <p>
          {t("widgetPendingPossible", { pending: week.me.pending, possible: week.me.possible })}
        </p>
        {week.me.target !== null ? (
          <>
            <p>{t("targetLine", { earned: week.me.earned, target: week.me.target })}</p>
            <Target
              earned={week.me.earned}
              target={week.me.target}
              label={t("targetProgressLabel")}
            />
          </>
        ) : null}
        {link}
      </div>
    );
  }
  const who = await serverPerson(memberNames(members.value));
  const rows = week.members
    .map((row) => ({ ...row, name: who({ me: row.me, member: row.member }) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-2 text-body text-fg" data-testid="weekly-points-widget">
      <p className="text-helper text-fg-muted">{range}</p>
      {rows.length === 0 ? (
        <p className="text-fg-muted">{t("widgetNobodyShares")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="weekly-points-members">
          {rows.map((row) => (
            <li key={row.member} className="flex flex-col gap-1">
              <span className="font-semibold">
                <bdi>{row.name}</bdi>
              </span>
              <span className="text-helper text-fg-muted">
                {t("widgetMemberWeek", {
                  earned: row.earned,
                  pending: row.pending,
                  possible: row.possible,
                })}
              </span>
              <Target
                earned={row.earned}
                target={row.target}
                label={t("targetProgressOf", { person: row.name })}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="text-helper text-fg-muted" data-testid="weekly-points-unassigned">
        {t("widgetUnassigned", { points: week.unassignedPossible ?? 0 })}
      </p>
      {link}
    </div>
  );
}

/** The Leaderboard widget (S23): the top members of a period; calm when the Home turned it off. */
export async function LeaderboardWidget({
  homeId,
  period,
  count,
}: {
  readonly homeId: string;
  readonly period: LeaderboardPeriod | null;
  readonly count: number;
}) {
  const [t, board, members] = await Promise.all([
    getTranslations("Points"),
    getLeaderboard(homeId, period),
    listTaskMembers(homeId),
  ]);
  if (board.status !== "ok" || members.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  if (!board.value.enabled) {
    return (
      <div data-testid="leaderboard-widget">
        <EmptyState title={t("leaderboardOffTitle")} description={t("leaderboardOff")} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="leaderboard-widget">
      <p className="text-helper text-fg-muted">{t(`period_${board.value.period}`)}</p>
      <LeaderboardRows
        board={board.value}
        names={memberNames(members.value)}
        limit={count}
        testId="leaderboard-widget-rows"
      />
      <Link
        href={leaderboardPath(homeId)}
        className="text-helper font-medium text-accent-fg underline"
      >
        {t("widgetOpenLeaderboard")}
      </Link>
    </div>
  );
}

/** The My points widget (S23): the viewer's own available and reserved points and what they can afford. */
export async function MyPointsWidget({ homeId }: { readonly homeId: string }) {
  const [t, summary, rewards] = await Promise.all([
    getTranslations("Points"),
    getPointSummary(homeId),
    listRewards(homeId),
  ]);
  if (summary.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  const totals = summary.value.totals;
  const affordable =
    rewards.status === "ok"
      ? rewards.value.filter((reward) => reward.block === null && reward.canAfford).slice(0, 3)
      : [];
  return (
    <div className="flex flex-col gap-2 text-body text-fg" data-testid="my-points-widget">
      <p
        className={
          totals.available < 0
            ? "text-section-title font-semibold text-danger"
            : "text-section-title font-semibold"
        }
        data-testid="my-points-available"
      >
        {t("widgetAvailable", { points: totals.available })}
      </p>
      {totals.reserved > 0 ? <p>{t("widgetReserved", { points: totals.reserved })}</p> : null}
      {totals.owed ? <p className="font-semibold text-danger">{t("owedShort")}</p> : null}
      {affordable.length > 0 ? (
        <>
          <p className="text-helper text-fg-muted">{t("widgetAffordable")}</p>
          <ul className="flex flex-col gap-1">
            {affordable.map((reward) => (
              <li key={reward.id} className="flex justify-between gap-2">
                <bdi>{reward.name}</bdi>
                <span className="text-fg-muted">{reward.cost}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Link href={rewardsPath(homeId)} className="text-helper font-medium text-accent-fg underline">
        {t("widgetOpenRewards")}
      </Link>
    </div>
  );
}
