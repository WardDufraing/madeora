"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  goalEndpoint,
  sendGoalRequest,
  type GoalDetail,
  type GoalEntries,
  type GoalEntry,
  type GoalEvent,
  type GoalEvents,
} from "@/goals/api";
import { goalKeys } from "@/goals/format";
import type { MemberNames } from "@/tasks/format";

import { CorrectEntryDialog } from "./goal-dialogs";
import { useGoalTexts } from "./use-goal-texts";

const eventKey = {
  created: "eventCreated",
  edited: "eventEdited",
  target_changed: "eventTargetChanged",
  adjusted: "eventAdjusted",
  corrected: "eventCorrected",
  achieved: "eventAchieved",
  reopened: "eventReopened",
  archived: "eventArchived",
  unarchived: "eventUnarchived",
  restored: "eventRestored",
  reminders_changed: "eventRemindersChanged",
} as const satisfies Record<GoalEvent["kind"], string>;

/** The goal's entries, newest first, fifty at a time, each page after the last entry before. */
function useEntryPages(goalId: string) {
  return useInfiniteQuery({
    queryKey: goalKeys.entries(goalId),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const search = pageParam ? `?before=${encodeURIComponent(pageParam)}` : "";
      const answer = await sendGoalRequest<{ entries: GoalEntries }>(
        "GET",
        `${goalEndpoint(goalId, "entries")}${search}`,
      );
      return answer.entries;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: GoalEntries) =>
      last.hasMore ? (last.entries.at(-1)?.id ?? undefined) : undefined,
  });
}

function useEventPages(goalId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: goalKeys.events(goalId),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const search = pageParam ? `?before=${encodeURIComponent(pageParam)}` : "";
      const answer = await sendGoalRequest<{ history: GoalEvents }>(
        "GET",
        `${goalEndpoint(goalId, "history")}${search}`,
      );
      return answer.history;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: GoalEvents) =>
      last.hasMore ? (last.events.at(-1)?.id ?? undefined) : undefined,
    enabled,
  });
}

function EntryRow({
  goal,
  entry,
  names,
  onCorrect,
}: {
  readonly goal: GoalDetail;
  readonly entry: GoalEntry;
  readonly names: MemberNames;
  readonly onCorrect: (entry: GoalEntry) => void;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const reversed = entry.status === "reversed";
  const amount = texts.amount(entry.quantity, entry.unit, entry.unitKind);
  return (
    <li className="flex flex-col gap-1 border-b border-line py-2" data-testid="goal-entry">
      <div className="flex flex-wrap items-center gap-2 text-body text-fg">
        <span className={reversed ? "line-through" : undefined}>
          {t(entry.kind === "adjustment" ? "entryAdjustmentLine" : "entryLine", {
            kind: texts.entryKind(entry.kind),
            amount: entry.kind === "adjustment" && entry.quantity > 0 ? `+${amount}` : amount,
            person: texts.who(entry.by, entry.mine, names),
            at: texts.instant(entry.recordedAt, goal.timeZone),
          })}
        </span>
        {reversed ? <span className="text-helper text-fg-muted">{t("entryReversed")}</span> : null}
        {entry.action ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t(entry.action === "correct" ? "correctEntry" : "reverseEntry", {
              amount,
            })}
            onClick={() => {
              onCorrect(entry);
            }}
            data-testid="goal-entry-correct"
          >
            {entry.action === "correct" ? t("correct") : t("reverse")}
          </Button>
        ) : null}
      </div>
      {entry.note ? (
        <p className="whitespace-pre-line text-helper text-fg-muted">
          <bdi>{entry.note}</bdi>
        </p>
      ) : null}
      {entry.corrections.length > 0 ? (
        <ul className="ps-4 text-helper text-fg-muted">
          {entry.corrections.map((correction) => (
            <li key={`${correction.at}-${correction.action}`}>
              {correction.action === "reverse"
                ? t("correctionReversed", {
                    person: texts.who(correction.by, correction.mine, names),
                    at: texts.instant(correction.at, goal.timeZone),
                  })
                : t("correctionAmended", {
                    before: texts.amount(correction.before, entry.unit, entry.unitKind),
                    after: texts.amount(correction.after ?? 0, entry.unit, entry.unitKind),
                    person: texts.who(correction.by, correction.mine, names),
                    at: texts.instant(correction.at, goal.timeZone),
                  })}
              {correction.reason ? (
                <>
                  {" · "}
                  {t("reasonLine")} <bdi>{correction.reason}</bdi>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A measurable goal's contributions, initial value and adjustments, newest first with who added
 * what, when and any corrections. Correct (managers) or Reverse (the contributor's own) where the
 * database says the viewer may.
 */
export function GoalEntriesList({
  goal,
  names,
}: {
  readonly goal: GoalDetail;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Goals");
  const [correcting, setCorrecting] = useState<GoalEntry | null>(null);
  const pages = useEntryPages(goal.id);
  const rows = pages.data?.pages.flatMap((page) => page.entries) ?? [];
  return (
    <section aria-labelledby="goal-entries-heading" className="flex flex-col gap-2">
      <h2 id="goal-entries-heading" className="text-section-title font-semibold">
        {t("entriesTitle")}
      </h2>
      {pages.isError ? <p className="text-body text-danger">{t("historyFailed")}</p> : null}
      {rows.length === 0 && !pages.isPending ? (
        <p className="text-helper text-fg-muted">{t("noEntries")}</p>
      ) : null}
      <ul className="flex flex-col" data-testid="goal-entries">
        {rows.map((entry) => (
          <EntryRow
            key={entry.id}
            goal={goal}
            entry={entry}
            names={names}
            onCorrect={setCorrecting}
          />
        ))}
      </ul>
      {pages.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={pages.isFetchingNextPage}
            onClick={() => {
              void pages.fetchNextPage();
            }}
          >
            {t("showMore")}
          </Button>
        </div>
      ) : null}
      {correcting ? (
        <CorrectEntryDialog
          goal={goal}
          entry={correcting}
          names={names}
          onClose={() => {
            setCorrecting(null);
          }}
        />
      ) : null}
    </section>
  );
}

/** What changed and when (codes and numbers only), loaded when the person opens it. */
export function GoalEventsList({
  goal,
  names,
}: {
  readonly goal: GoalDetail;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const [open, setOpen] = useState(false);
  const pages = useEventPages(goal.id, open);
  const rows = pages.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <section aria-labelledby="goal-events-heading" className="flex flex-col gap-2">
      <h2 id="goal-events-heading" className="text-section-title font-semibold">
        {t("historyTitle")}
      </h2>
      {open ? null : (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
            data-testid="goal-history-show"
          >
            {t("historyShow")}
          </Button>
        </div>
      )}
      {pages.isError ? <p className="text-body text-danger">{t("historyFailed")}</p> : null}
      {open ? (
        <ul className="flex flex-col gap-1 text-body text-fg" data-testid="goal-events">
          {rows.map((event) => (
            <li key={event.id}>
              {t(eventKey[event.kind], {
                person: texts.who(event.by, event.mine, names),
                at: texts.instant(event.at, goal.timeZone),
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {open && pages.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={pages.isFetchingNextPage}
            onClick={() => {
              void pages.fetchNextPage();
            }}
          >
            {t("showMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
