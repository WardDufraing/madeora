"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  habitEndpoint,
  sendHabitRequest,
  type HabitCheckin,
  type HabitDetail,
  type HabitEvent,
} from "@/habits/api";
import { habitKeys } from "@/habits/format";
import type { MemberNames } from "@/tasks/format";

import { CorrectDialog } from "./habit-dialogs";
import { useHabitTexts } from "./use-habit-texts";

/** The server answers at most this many rows per page. */
const PAGE = 50;

const eventKey = {
  created: "eventCreated",
  edited: "eventEdited",
  schedule_changed: "eventScheduleChanged",
  end_changed: "eventEndChanged",
  paused: "eventPaused",
  pause_changed: "eventPauseChanged",
  resumed: "eventResumed",
  archived: "eventArchived",
  unarchived: "eventUnarchived",
  restored: "eventRestored",
  reactivated: "eventReactivated",
  reminders_changed: "eventRemindersChanged",
  checked_in: "eventCheckedIn",
  undone: "eventUndone",
  corrected: "eventCorrected",
  note_added: "eventNoteAdded",
  note_edited: "eventNoteEdited",
  note_removed: "eventNoteRemoved",
  vacation_pause_changed: "eventVacationPauseChanged",
  tracking_changed: "eventTrackingChanged",
  contribution_corrected: "eventContributionCorrected",
} as const satisfies Record<HabitEvent["kind"], string>;

/** Pages of check-ins or events; each page continues after the last row of the one before. */
function useHistoryPages<T extends { readonly id: string }>(
  habitId: string,
  kind: "checkins" | "events",
) {
  return useInfiniteQuery({
    queryKey: habitKeys.history(habitId, kind),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const search = new URLSearchParams({ kind });
      if (pageParam) search.set("before", pageParam);
      const answer = await sendHabitRequest<Record<string, readonly T[]>>(
        "GET",
        `${habitEndpoint(habitId, "history")}?${search.toString()}`,
      );
      return answer[kind] ?? [];
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: readonly T[]) => {
      const tail = last.at(-1);
      return last.length < PAGE || tail === undefined ? undefined : tail.id;
    },
  });
}

/**
 * A habit's check-ins (active and undone, with who undid or corrected them and why) and its change
 * log, newest first, fifty at a time. Habit managers correct older check-ins from here.
 */
export function HabitHistory({
  habit,
  names,
}: {
  readonly habit: HabitDetail;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const format = useFormatter();
  const [correcting, setCorrecting] = useState<HabitCheckin | null>(null);
  const checkins = useHistoryPages<HabitCheckin>(habit.id, "checkins");
  const events = useHistoryPages<HabitEvent>(habit.id, "events");
  const checkinRows = checkins.data?.pages.flat() ?? [];
  const eventRows = events.data?.pages.flat() ?? [];
  return (
    <section aria-labelledby="habit-history-heading" className="flex flex-col gap-4">
      <h2 id="habit-history-heading" className="text-section-title font-semibold">
        {t("historyTitle")}
      </h2>
      <div className="flex flex-col gap-2">
        <h3 className="text-body font-semibold text-fg">{t("checkinsTitle")}</h3>
        {checkins.isError ? <p className="text-body text-danger">{t("historyFailed")}</p> : null}
        {checkinRows.length === 0 && !checkins.isPending ? (
          <p className="text-helper text-fg-muted">{t("noCheckins")}</p>
        ) : null}
        <ul className="flex flex-col gap-1" data-testid="habit-checkins">
          {checkinRows.map((checkin) => (
            <li key={checkin.id} className="flex flex-wrap items-center gap-2 text-body text-fg">
              <span>
                {checkin.status === "active"
                  ? t("checkinLine", {
                      date: texts.date(checkin.onDate, "short"),
                      person: texts.who(checkin.by, checkin.mine, names),
                    })
                  : t(
                      checkin.undoKind === "correction"
                        ? "checkinCorrectedLine"
                        : "checkinUndoneLine",
                      {
                        date: texts.date(checkin.onDate, "short"),
                        person: texts.who(checkin.by, checkin.mine, names),
                        by: texts.who(checkin.undoneBy, checkin.undoneByMe, names),
                      },
                    )}
              </span>
              {checkin.undoReason ? (
                <span className="text-helper text-fg-muted">
                  {t("reasonLine")} <bdi>{checkin.undoReason}</bdi>
                </span>
              ) : null}
              {checkin.action === "correct" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("correctOn", { date: texts.date(checkin.onDate, "short") })}
                  onClick={() => {
                    setCorrecting(checkin);
                  }}
                >
                  {t("correct")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {checkins.hasNextPage ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              loading={checkins.isFetchingNextPage}
              onClick={() => {
                void checkins.fetchNextPage();
              }}
            >
              {t("showOlder")}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-body font-semibold text-fg">{t("eventsTitle")}</h3>
        {events.isError ? <p className="text-body text-danger">{t("historyFailed")}</p> : null}
        <ul className="flex flex-col gap-1" data-testid="habit-events">
          {eventRows.map((event) => (
            <li key={event.id} className="text-body text-fg">
              <time dateTime={event.at} className="text-helper text-fg-muted">
                {format.dateTime(new Date(event.at), { dateStyle: "medium", timeStyle: "short" })}
              </time>{" "}
              {t(eventKey[event.kind], {
                person: texts.who(event.by, event.mine, names),
                date: event.onDate ? texts.date(event.onDate, "short") : "",
              })}
            </li>
          ))}
        </ul>
        {events.hasNextPage ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              loading={events.isFetchingNextPage}
              onClick={() => {
                void events.fetchNextPage();
              }}
            >
              {t("showOlder")}
            </Button>
          </div>
        ) : null}
      </div>
      {correcting ? (
        <CorrectDialog
          checkin={correcting}
          habitName={habit.name}
          onClose={() => {
            setCorrecting(null);
          }}
        />
      ) : null}
    </section>
  );
}
