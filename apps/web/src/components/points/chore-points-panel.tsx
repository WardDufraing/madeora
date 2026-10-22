import { getTranslations } from "next-intl/server";

import { serverPerson } from "@/components/vacations/vacations-page";
import type { ChorePerson } from "@/chores/api";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import type { ChorePoints } from "@/points/api";
import type { MemberNames } from "@/tasks/format";

import { ChorePointsCorrect } from "./chore-points-correct";

/** A late policy in words, for a base value. */
export async function latePolicyText(setting: {
  readonly latePolicy: ChorePoints["latePolicy"];
  readonly latePoints: number | null;
}): Promise<string> {
  const t = await getTranslations("Points");
  return setting.latePolicy === "reduced"
    ? t("lateReduced", { points: setting.latePoints ?? 0 })
    : setting.latePolicy === "zero"
      ? t("lateZero")
      : t("lateFull");
}

/**
 * An occurrence's points (S23; every member of its Home): the base value and late policy, what
 * completing now earns, the award a submission waits for, the awarded points and their ledger lines
 * (never a balance or a reason). Chore managers correct the points here.
 */
export async function ChorePointsPanel({
  occurrenceId,
  revision,
  status,
  points,
  names,
  formats,
}: {
  readonly occurrenceId: string;
  readonly revision: number;
  readonly status: string;
  readonly points: ChorePoints;
  readonly names: MemberNames;
  readonly formats: DateTimeFormats;
}) {
  const t = await getTranslations("Points");
  const who = await serverPerson(names);
  const person = (value: ChorePerson | null) => who(value);
  const differs =
    points.chore.points !== points.points ||
    points.chore.latePolicy !== points.latePolicy ||
    points.chore.latePoints !== points.latePoints;
  return (
    <section aria-labelledby="chore-points-heading" className="flex flex-col gap-3">
      <h2 id="chore-points-heading" className="text-section-title font-semibold text-fg">
        {t("chorePointsHeading")}
      </h2>
      <dl
        className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_1fr]"
        data-testid="chore-points"
      >
        <dt className="font-medium text-fg">{t("basePoints")}</dt>
        <dd className="text-fg" data-testid="chore-points-base">
          {t("pointsValue", { points: points.points })}
        </dd>
        <dt className="font-medium text-fg">{t("fieldLatePolicy")}</dt>
        <dd className="text-fg">{await latePolicyText(points)}</dd>
        {status === "open" ? (
          <>
            <dt className="font-medium text-fg">{t("earnsNow")}</dt>
            <dd className="text-fg" data-testid="chore-points-expected">
              {points.lateNow
                ? t("earnsNowLate", { points: points.expectedNow })
                : t("pointsValue", { points: points.expectedNow })}
            </dd>
          </>
        ) : null}
        {points.pending ? (
          <>
            <dt className="font-medium text-fg">{t("pendingAward")}</dt>
            <dd className="text-fg" data-testid="chore-points-pending">
              {t(points.pending.late ? "pendingAwardTextLate" : "pendingAwardText", {
                person: person(points.pending.person),
                points: points.pending.amount,
              })}
            </dd>
          </>
        ) : null}
        {points.awarded ? (
          <>
            <dt className="font-medium text-fg">{t("awarded")}</dt>
            <dd className="text-fg" data-testid="chore-points-awarded">
              {t(points.awarded.late ? "awardedTextLate" : "awardedText", {
                person: person(points.awarded.person),
                points: points.awarded.amount,
              })}
            </dd>
          </>
        ) : null}
      </dl>
      {differs && points.chore.scheduledOther !== null ? (
        <p className="text-helper text-fg-muted">
          {t("choreNowEarns", { points: points.chore.points })}
        </p>
      ) : null}
      {points.entries.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-body font-semibold text-fg">{t("ledgerLines")}</h3>
          <ul className="flex flex-col gap-1 text-body text-fg" data-testid="chore-points-entries">
            {points.entries.map((entry, index) => (
              <li key={index}>
                {t("entryLine", {
                  kind: t(`kind_${entry.kind}`),
                  person: person(entry.person),
                  amount: entry.amount > 0 ? `+${String(entry.amount)}` : String(entry.amount),
                  date: formatDateTime(entry.createdAt, formats),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {points.canCorrect ? (
        <ChorePointsCorrect
          occurrenceId={occurrenceId}
          revision={revision}
          points={points}
          completed={status === "completed"}
          names={names}
        />
      ) : null}
    </section>
  );
}
