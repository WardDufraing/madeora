import { targetProgress } from "@madeora/domain/points";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { serverPerson } from "@/components/vacations/vacations-page";
import { choresPath } from "@/chores/format";
import { getDateTimeFormats } from "@/invitations/server";
import type { PointTotals } from "@/points/api";
import { getPointSummary, listPointAccounts, listPointEntries } from "@/points/data";
import { leaderboardPath, pointsPath, rewardsPath } from "@/points/format";
import { listTaskMembers } from "@/tasks/data";
import { formatTaskDate, memberNames } from "@/tasks/format";

import { AdjustPoints } from "./adjust-points";
import { PointLedgerList } from "./point-ledger";
import { PointPreferences } from "./point-preferences";

async function Totals({
  totals,
  testId,
}: {
  readonly totals: PointTotals;
  readonly testId: string;
}) {
  const t = await getTranslations("Points");
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["available", totals.available],
            ["reserved", totals.reserved],
            ["earned", totals.earned],
            ["spent", totals.spent],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-card border border-line bg-surface p-3">
            <dt className="text-helper text-fg-muted">{t(key)}</dt>
            <dd
              className={
                key === "available" && value < 0
                  ? "text-section-title font-semibold text-danger"
                  : "text-section-title font-semibold text-fg"
              }
              data-testid={`${testId}-${key}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {totals.owed ? (
        <p className="text-body font-semibold text-danger" data-testid={`${testId}-owed`}>
          {t("owed", { points: -totals.available })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A Home's points page (S23): the person's own available, reserved, earned and spent points
 * ("Points owed" when chore reversals took them below zero), this week's chore points and target,
 * their own leaderboard choices, and their ledger. Points managers also see every account (former
 * members' preserved ones too) and open one to give a bonus or correction. Nobody else's balance
 * is ever shown to anyone else.
 */
export async function PointsPage({
  home,
  accountId,
  before,
}: {
  readonly home: { readonly id: string; readonly name: string };
  readonly accountId: string | null;
  readonly before: number | null;
}) {
  const [t, formats, summary, members] = await Promise.all([
    getTranslations("Points"),
    getDateTimeFormats(),
    getPointSummary(home.id),
    listTaskMembers(home.id),
  ]);
  const base = pointsPath(home.id);
  const header = (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={rewardsPath(home.id)} className="font-medium text-accent-fg underline">
          {t("rewardsLink")}
        </Link>
        {summary.status === "ok" && summary.value.leaderboardEnabled ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link href={leaderboardPath(home.id)} className="font-medium text-accent-fg underline">
              {t("leaderboardLink")}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={choresPath(home.id)} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
      </p>
    </>
  );
  if (summary.status !== "ok" || members.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  const value = summary.value;
  const names = memberNames(members.value);
  const who = await serverPerson(names);
  const viewing = value.canManagePoints && accountId !== null ? accountId : null;
  const [ledger, accounts] = await Promise.all([
    listPointEntries(home.id, viewing, viewing === null ? before : null),
    value.canManagePoints ? listPointAccounts(home.id) : null,
  ]);
  const ownLedger = viewing === null && ledger.status === "ok" ? ledger.value : null;
  const progress = value.targetPaused ? null : targetProgress(value.week.earned, value.target);

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        <section aria-labelledby="points-mine-heading" className="flex flex-col gap-3">
          <h2 id="points-mine-heading" className="text-section-title font-semibold text-fg">
            {t("mineHeading")}
          </h2>
          <Totals totals={value.totals} testId="points-totals" />
          {value.totals.reserved > 0 ? (
            <p className="text-helper text-fg-muted">{t("reservedHelp")}</p>
          ) : null}
        </section>

        <section aria-labelledby="points-week-heading" className="flex flex-col gap-3">
          <h2 id="points-week-heading" className="text-section-title font-semibold text-fg">
            {t("weekHeading", {
              from: formatTaskDate(value.week.startsOn, formats),
              to: formatTaskDate(value.week.endsOn, formats),
            })}
          </h2>
          <p className="text-body text-fg" data-testid="points-week">
            {t("weekLine", {
              earned: value.week.earned,
              pending: value.week.pending,
              possible: value.week.possible,
            })}
          </p>
          {progress ? (
            <div className="flex flex-col gap-1" data-testid="points-target">
              <p className="text-body text-fg">
                {t("targetLine", { earned: progress.earned, target: progress.target })}
              </p>
              <div
                role="progressbar"
                aria-label={t("targetProgressLabel")}
                aria-valuemin={0}
                aria-valuemax={progress.target}
                aria-valuenow={Math.max(Math.min(progress.earned, progress.target), 0)}
                className="h-2 w-full max-w-md overflow-hidden rounded-full bg-surface-sunken"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${String(Math.round(progress.ratio * 100))}%` }}
                />
              </div>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="points-choices-heading" className="flex flex-col gap-3">
          <h2 id="points-choices-heading" className="text-section-title font-semibold text-fg">
            {t("choicesHeading")}
          </h2>
          <PointPreferences
            homeId={home.id}
            participates={value.participates}
            target={value.target}
            targetPaused={value.targetPaused}
            shareTarget={value.shareTarget}
          />
        </section>

        {ownLedger ? (
          <section aria-labelledby="points-ledger-heading" className="flex flex-col gap-3">
            <h2 id="points-ledger-heading" className="text-section-title font-semibold text-fg">
              {t("ledgerHeading")}
            </h2>
            <PointLedgerList
              ledger={ownLedger}
              names={names}
              formats={formats}
              nextHref={ownLedger.next === null ? null : `${base}?before=${String(ownLedger.next)}`}
            />
          </section>
        ) : null}

        {accounts?.status === "ok" ? (
          <section aria-labelledby="points-members-heading" className="flex flex-col gap-3">
            <h2 id="points-members-heading" className="text-section-title font-semibold text-fg">
              {t("membersHeading")}
            </h2>
            <p className="text-helper text-fg-muted">{t("membersHelp")}</p>
            <ul
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="points-accounts"
            >
              {accounts.value.map((row, index) => {
                const label = row.former
                  ? t("formerMember")
                  : who({ me: row.memberId === names.selfId, member: row.memberId });
                return (
                  <li
                    key={row.accountId ?? row.memberId ?? index}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                    data-testid="points-account"
                  >
                    <div className="flex flex-col">
                      <span className="text-body font-semibold text-fg">
                        <bdi>{label}</bdi>
                      </span>
                      <span className="text-helper text-fg-muted">
                        {t("accountLine", {
                          available: row.totals.available,
                          reserved: row.totals.reserved,
                          earned: row.totals.earned,
                        })}
                        {row.totals.owed ? (
                          <span className="ms-2 font-semibold text-danger">{t("owedShort")}</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {row.accountId ? (
                        <Link
                          href={`${base}?account=${row.accountId}`}
                          className="text-body font-medium text-accent-fg underline"
                          aria-label={t("openLedgerFor", { person: label })}
                        >
                          {t("openLedger")}
                        </Link>
                      ) : null}
                      {row.memberId && !row.former ? (
                        <AdjustPoints
                          homeId={home.id}
                          memberId={row.memberId}
                          memberLabel={label}
                          names={names}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {viewing !== null && ledger.status === "ok" && ledger.value.account ? (
          <section aria-labelledby="points-account-heading" className="flex flex-col gap-3">
            <h2 id="points-account-heading" className="text-section-title font-semibold text-fg">
              {t("accountHeading", {
                person: ledger.value.account.former
                  ? t("formerMember")
                  : who(ledger.value.account.person),
              })}
            </h2>
            <Totals totals={ledger.value.account} testId="points-account-totals" />
            <PointLedgerList
              ledger={ledger.value}
              names={names}
              formats={formats}
              nextHref={null}
            />
            <Link href={base} className="text-body font-medium text-accent-fg underline">
              {t("closeLedger")}
            </Link>
          </section>
        ) : null}
      </div>
    </>
  );
}
