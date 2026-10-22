"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { CHORE_OCCURRENCES_ENDPOINT, sendChoreRequest, type ChoreRequestError } from "@/chores/api";
import type { ChorePointsChange } from "@/points/api";
import type { MemberNames } from "@/tasks/format";

export type PointsPreviewRequest =
  | { readonly action: "reopen" }
  | {
      readonly action: "correct";
      readonly contributor: string | null;
      readonly completedAt: string | null;
    };

function previewUrl(occurrenceId: string, request: PointsPreviewRequest): string {
  const params = new URLSearchParams({ preview: request.action });
  if (request.action === "correct") {
    if (request.contributor) params.set("contributor", request.contributor);
    if (request.completedAt) params.set("completedAt", request.completedAt);
  }
  return `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/points?${params.toString()}`;
}

/**
 * The point change a reopen or correction would make (S23), read again whenever the choices
 * change: who loses and who gains how many points, and (for points managers) the available points
 * after. Nothing when it changes no points. Without manageHomePoints the change is refused, which
 * the note says before the person confirms.
 */
export function PointsChangeNote({
  occurrenceId,
  request,
  names,
}: {
  readonly occurrenceId: string;
  readonly request: PointsPreviewRequest | null;
  readonly names: MemberNames;
}) {
  const texts = useChoreTexts(names);
  const query = useQuery<{ change: ChorePointsChange | null }, ChoreRequestError>({
    queryKey: ["chores", "points-preview", occurrenceId, request],
    queryFn: () =>
      sendChoreRequest("GET", previewUrl(occurrenceId, request ?? { action: "reopen" })),
    enabled: request !== null,
    gcTime: 0,
    staleTime: 0,
  });
  const change = query.data?.change;
  if (!request || !change) return null;
  return <PointsChangeView change={change} person={texts.person} testId="points-change" />;
}

/** A change of awarded points, as a short list. */
export function PointsChangeView({
  change,
  person,
  testId,
}: {
  readonly change: ChorePointsChange;
  readonly person: (who: ChorePointsChange["from"]) => string;
  readonly testId: string;
}) {
  const t = useTranslations("Points");
  return (
    <div
      className="flex flex-col gap-1 rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
      data-testid={testId}
    >
      <p className="font-semibold">{t("changeHeading")}</p>
      <ul className="flex flex-col gap-1">
        {change.affected.map((row, index) => (
          <li key={index}>
            {t(row.change >= 0 ? "changeGain" : "changeLoss", {
              person: person(row.person),
              points: Math.abs(row.change),
            })}
            {row.availableAfter !== null ? (
              <span className="ms-2 text-fg-muted">
                {t("changeAvailableAfter", { points: row.availableAfter })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {change.permitted === false ? (
        <p className="font-semibold text-danger">{t("changeNotPermitted")}</p>
      ) : null}
    </div>
  );
}
