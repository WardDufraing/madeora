import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { formatDateTime } from "@/invitations/format";
import type { DateTimeFormats } from "@/invitations/format";
import type { MemberNames } from "@/tasks/format";
import type { ChoreVacationState } from "@/vacations/api";
import { vacationsPath } from "@/vacations/format";

import { serverPerson } from "./vacations-page";

/**
 * How a Home vacation affects one occurrence (S22), on its page: paused for a Home vacation, a
 * rotation turn taken for someone away, nobody available, waiting for a vacation review, and
 * assignees away on its due date (absences only for chore managers and the absent member). Nothing
 * when no vacation touches it.
 */
export async function VacationStateNote({
  homeId,
  state,
  names,
  formats,
}: {
  readonly homeId: string;
  readonly state: ChoreVacationState;
  readonly names: MemberNames;
  readonly formats: DateTimeFormats;
}) {
  const lines: string[] = [];
  const t = await getTranslations("Vacations");
  const who = await serverPerson(names);
  if (state.state === "paused") lines.push(t("statePaused"));
  if (state.state === "substitute") {
    lines.push(t("stateSubstitute", { person: who(state.substituteFor) }));
  }
  if (state.state === "review") {
    lines.push(t("stateNoSubstitute", { person: who(state.substituteFor) }));
  }
  if (state.review) lines.push(t("stateReview"));
  if (state.away.length > 0) {
    lines.push(t("stateAway", { names: state.away.map(who).join(", ") }));
  }
  if (state.absent.length > 0) {
    lines.push(t("stateAbsent", { names: state.absent.map(who).join(", ") }));
  }
  for (const decision of state.decisions) {
    lines.push(
      t(`stateDecision_${decision.decision}`, {
        person: who(decision.by),
        date: formatDateTime(decision.at, formats),
      }),
    );
  }
  if (lines.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
      data-testid="chore-vacation-state"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p>
        <Link href={vacationsPath(homeId)} className="font-medium text-accent-fg underline">
          {t("openVacations")}
        </Link>
      </p>
    </div>
  );
}
