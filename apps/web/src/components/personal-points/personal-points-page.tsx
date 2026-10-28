import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { signedPoints } from "@/points/format";
import {
  PERSONAL_POINTS_PATH,
  PERSONAL_REWARDS_PATH,
  type PersonalEntry,
} from "@/points/personal-api";
import { getPersonalPoints } from "@/points/personal-data";

import { PersonalAdjust, PersonalReverse } from "./personal-adjust";

/**
 * Personal points (S28b): the person's own available, earned and spent points, Add points or
 * correct, and their ledger, in the Personal context whether or not they belong to any Home. Read
 * with their own session: nobody else's ledger can ever appear here, and no Home's balance either.
 */
export async function PersonalPointsPage({ before }: { readonly before: number | null }) {
  const [t, tp, formats, points] = await Promise.all([
    getTranslations("PersonalPoints"),
    getTranslations("Points"),
    getDateTimeFormats(),
    getPersonalPoints(before),
  ]);
  const header = (
    <>
      <PageHeader title={t("pointsTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <span>{t("personalContext")}</span>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={PERSONAL_REWARDS_PATH} className="font-medium text-accent-fg underline">
          {t("rewardsLink")}
        </Link>
      </p>
    </>
  );
  if (points.status !== "ok") {
    return (
      <>
        {header}
        <ErrorState title={tp("loadFailedTitle")} description={tp("loadFailed")} />
      </>
    );
  }
  const { totals, entries, next } = points.value;
  const subject = (entry: PersonalEntry) => entry.redemption?.rewardName ?? null;
  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-8">
        <section aria-labelledby="personal-points-heading" className="flex flex-col gap-3">
          <h2 id="personal-points-heading" className="text-section-title font-semibold text-fg">
            {t("mineHeading")}
          </h2>
          <dl className="grid grid-cols-3 gap-3" data-testid="personal-totals">
            {(
              [
                ["available", totals.available],
                ["earned", totals.earned],
                ["spent", totals.spent],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="rounded-card border border-line bg-surface p-3">
                <dt className="text-helper text-fg-muted">{tp(key)}</dt>
                <dd
                  className="text-section-title font-semibold text-fg"
                  data-testid={`personal-totals-${key}`}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-helper text-fg-muted">{t("privacyNote")}</p>
          <div>
            <PersonalAdjust />
          </div>
        </section>

        <section aria-labelledby="personal-ledger-heading" className="flex flex-col gap-3">
          <h2 id="personal-ledger-heading" className="text-section-title font-semibold text-fg">
            {tp("ledgerHeading")}
          </h2>
          {entries.length === 0 ? (
            <p className="text-body text-fg-muted">{tp("ledgerEmpty")}</p>
          ) : (
            <ol
              className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
              data-testid="personal-ledger"
            >
              {entries.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-1 p-3" data-testid="personal-entry">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-body font-semibold text-fg">
                      {t(`kind_${entry.kind}`)}
                      {subject(entry) ? (
                        <>
                          {": "}
                          <bdi>{subject(entry)}</bdi>
                        </>
                      ) : null}
                    </span>
                    <span
                      className={
                        entry.amount < 0
                          ? "text-body font-semibold text-danger"
                          : "text-body font-semibold text-fg"
                      }
                      data-testid="personal-entry-amount"
                    >
                      {signedPoints(entry.amount)}
                    </span>
                  </div>
                  <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
                    <span>{formatDateTime(entry.createdAt, formats)}</span>
                    <span>{tp("entryAvailableAfter", { points: entry.availableAfter })}</span>
                    {entry.reversed ? (
                      <span className="font-semibold">{tp("entryReversed")}</span>
                    ) : null}
                  </p>
                  {entry.reason ? (
                    <p className="break-words text-body text-fg">
                      <span className="font-medium">{tp("reasonLabel")}</span> {entry.reason}
                    </p>
                  ) : null}
                  {entry.canReverse ? (
                    <div>
                      <PersonalReverse entryId={entry.id} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {next !== null ? (
            <Link
              href={`${PERSONAL_POINTS_PATH}?before=${String(next)}`}
              className="text-body font-medium text-accent-fg underline"
            >
              {tp("ledgerOlder")}
            </Link>
          ) : null}
        </section>
      </div>
    </>
  );
}
