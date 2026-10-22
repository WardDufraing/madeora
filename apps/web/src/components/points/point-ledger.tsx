import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import type { PointEntry, PointLedger } from "@/points/api";
import { signedPoints } from "@/points/format";
import type { MemberNames } from "@/tasks/format";

import { serverPerson } from "@/components/vacations/vacations-page";

import { ReverseEntry } from "./adjust-points";

/**
 * One account's ledger, newest first (S23): what happened, the amount, who did it and why, and the
 * available points after. Only its holder and points managers ever see it. Bonuses and
 * corrections show Reverse for points managers.
 */
export async function PointLedgerList({
  ledger,
  names,
  formats,
  nextHref,
}: {
  readonly ledger: PointLedger;
  readonly names: MemberNames;
  readonly formats: DateTimeFormats;
  /** The address of the next page, when there is one. */
  readonly nextHref: string | null;
}) {
  const t = await getTranslations("Points");
  const who = await serverPerson(names);
  const subject = (entry: PointEntry) =>
    entry.occurrence
      ? entry.occurrence.title
      : entry.redemption
        ? entry.redemption.rewardName
        : null;
  if (ledger.entries.length === 0) {
    return <p className="text-body text-fg-muted">{t("ledgerEmpty")}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ol
        className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
        data-testid="point-ledger"
      >
        {ledger.entries.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-1 p-3" data-testid="point-entry">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-body font-semibold text-fg">
                {t(`kind_${entry.kind}`)}
                {subject(entry) ? (
                  <>
                    {": "}
                    <bdi>{subject(entry)}</bdi>
                  </>
                ) : null}
                {entry.late ? <span className="ms-2 font-normal">{t("lateMark")}</span> : null}
              </span>
              <span
                className={
                  entry.amount < 0
                    ? "text-body font-semibold text-danger"
                    : "text-body font-semibold text-fg"
                }
                data-testid="point-entry-amount"
              >
                {signedPoints(entry.amount)}
              </span>
            </div>
            <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
              <span>{formatDateTime(entry.createdAt, formats)}</span>
              {entry.actor ? <span>{t("entryBy", { person: who(entry.actor) })}</span> : null}
              <span>{t("entryAvailableAfter", { points: entry.availableAfter })}</span>
              {entry.reversed ? <span className="font-semibold">{t("entryReversed")}</span> : null}
            </p>
            {entry.reason ? (
              <p className="break-words text-body text-fg">
                <span className="font-medium">{t("reasonLabel")}</span> {entry.reason}
              </p>
            ) : null}
            {entry.canReverse ? (
              <div>
                <ReverseEntry entryId={entry.id} names={names} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {nextHref ? (
        <Link href={nextHref} className="text-body font-medium text-accent-fg underline">
          {t("ledgerOlder")}
        </Link>
      ) : null}
    </div>
  );
}
