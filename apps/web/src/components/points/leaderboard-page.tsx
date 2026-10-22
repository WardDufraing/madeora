import { leaderboardPeriods, type LeaderboardPeriod } from "@madeora/domain/points";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { serverPerson } from "@/components/vacations/vacations-page";
import { getDateTimeFormats } from "@/invitations/server";
import type { Leaderboard } from "@/points/api";
import { getLeaderboard, getPointSummary } from "@/points/data";
import { leaderboardPath, pointsPath } from "@/points/format";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames, type MemberNames } from "@/tasks/format";

import { LeaderboardSettings } from "./point-preferences";

/** The ranked rows, sorted within a rank by name (which implies nothing). */
export async function LeaderboardRows({
  board,
  names,
  limit,
  testId,
}: {
  readonly board: Leaderboard;
  readonly names: MemberNames;
  readonly limit?: number;
  readonly testId: string;
}) {
  const t = await getTranslations("Points");
  const who = await serverPerson(names);
  const rows = [...board.rows]
    .map((row) => ({ ...row, name: who({ me: row.me, member: row.member }) }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, limit ?? board.rows.length);
  if (rows.length === 0) {
    return <p className="text-body text-fg-muted">{t("leaderboardEmpty")}</p>;
  }
  return (
    <table className="w-full text-body" data-testid={testId}>
      <caption className="sr-only">
        {t("leaderboardCaption", { period: t(`period_${board.period}`) })}
      </caption>
      <thead>
        <tr className="text-start text-helper text-fg-muted">
          <th scope="col" className="p-2 text-start font-medium">
            {t("rank")}
          </th>
          <th scope="col" className="p-2 text-start font-medium">
            {t("member")}
          </th>
          <th scope="col" className="p-2 text-end font-medium">
            {t("earnedPoints")}
          </th>
          <th scope="col" className="p-2 text-end font-medium">
            {t("completedChores")}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((row) => (
          <tr
            key={row.member}
            className={row.me ? "font-semibold" : undefined}
            data-testid="leaderboard-row"
          >
            <td className="p-2">{row.rank}</td>
            <th scope="row" className="p-2 text-start font-normal">
              <bdi>{row.name}</bdi>
            </th>
            <td className="p-2 text-end">{row.earned}</td>
            <td className="p-2 text-end">{row.completed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A Home's leaderboard (S23; spec "Confirmed reward leaderboard"): week, month or all time, by
 * points earned in the period, then completed chores, sharing equal ranks. Only members who take
 * part are listed; balances, reservations and reasons never appear. Rewards managers turn it on or
 * off and choose the default period here.
 */
export async function LeaderboardPage({
  home,
  period,
}: {
  readonly home: { readonly id: string; readonly name: string };
  readonly period: LeaderboardPeriod | null;
}) {
  const [t, formats, board, summary, members] = await Promise.all([
    getTranslations("Points"),
    getDateTimeFormats(),
    getLeaderboard(home.id, period),
    getPointSummary(home.id),
    listTaskMembers(home.id),
  ]);
  const header = (
    <>
      <PageHeader title={t("leaderboardTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={pointsPath(home.id)} className="font-medium text-accent-fg underline">
          {t("backToPoints")}
        </Link>
      </p>
    </>
  );
  if (board.status !== "ok" || summary.status !== "ok" || members.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const value = board.value;
  const names = memberNames(members.value);
  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        {value.enabled ? (
          <section aria-labelledby="leaderboard-heading" className="flex flex-col gap-3">
            <h2 id="leaderboard-heading" className="text-section-title font-semibold text-fg">
              {t(`period_${value.period}`)}
            </h2>
            <nav aria-label={t("periodNav")} className="flex flex-wrap gap-3">
              {leaderboardPeriods.map((option) => (
                <Link
                  key={option}
                  href={`${leaderboardPath(home.id)}?period=${option}`}
                  aria-current={option === value.period ? "page" : undefined}
                  className={
                    option === value.period
                      ? "text-body font-semibold text-fg underline"
                      : "text-body font-medium text-accent-fg underline"
                  }
                >
                  {t(`period_${option}`)}
                </Link>
              ))}
            </nav>
            <p className="text-helper text-fg-muted">
              {t("leaderboardMetric")}{" "}
              {value.startsOn
                ? value.endsOn
                  ? t("periodRange", {
                      from: formatTaskDate(value.startsOn, formats),
                      to: formatTaskDate(value.endsOn, formats),
                    })
                  : t("periodSince", { from: formatTaskDate(value.startsOn, formats) })
                : null}
            </p>
            {value.participates === false ? (
              <p className="text-body text-fg" data-testid="leaderboard-opted-out">
                {t("leaderboardOptedOut")}{" "}
                <Link href={pointsPath(home.id)} className="font-medium text-accent-fg underline">
                  {t("changeChoice")}
                </Link>
              </p>
            ) : null}
            <div className="rounded-card border border-line bg-surface p-2">
              <LeaderboardRows board={value} names={names} testId="leaderboard" />
            </div>
          </section>
        ) : (
          <EmptyState title={t("leaderboardOffTitle")} description={t("leaderboardOff")} />
        )}
        {summary.value.canManageRewards ? (
          <section aria-labelledby="leaderboard-settings-heading" className="flex flex-col gap-3">
            <h2
              id="leaderboard-settings-heading"
              className="text-section-title font-semibold text-fg"
            >
              {t("leaderboardSettingsHeading")}
            </h2>
            <LeaderboardSettings
              homeId={home.id}
              enabled={summary.value.leaderboardEnabled}
              defaultPeriod={summary.value.defaultPeriod}
            />
          </section>
        ) : null}
      </div>
    </>
  );
}
