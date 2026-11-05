import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { calendarPath, clockTime, googleEventPath } from "@/calendar/format";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { readGoogleEvent } from "@/google-calendar/data";
import { settingsPath } from "@/google-calendar/schema";
import type { GoogleEvent } from "@/google-calendar/shapes";
import type { DateTimeFormats } from "@/invitations/format";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";
import { formatTaskDate } from "@/tasks/format";

import { GoogleChangePanel, GoogleEventActions } from "./google-event-actions";

function whenText(
  event: GoogleEvent,
  timeZone: string,
  formats: DateTimeFormats,
  t: Awaited<ReturnType<typeof getTranslations<"Calendar">>>,
): string {
  const date = (value: string) => formatTaskDate(value, formats);
  if (event.allDay || !event.startsAt || !event.endsAt) {
    return event.from === event.to
      ? t("whenAllDay", { date: date(event.from) })
      : t("whenAllDayRange", { from: date(event.from), to: date(event.to) });
  }
  const start = clockTime(event.startsAt, timeZone, formats);
  const end = clockTime(event.endsAt, timeZone, formats);
  return event.from === event.to
    ? t("whenTimed", { date: date(event.from), start, end })
    : t("whenTimedRange", { from: date(event.from), start, to: date(event.to), end });
}

/**
 * A Google event's page (S33): what, when (in the context's timezone, and the event's own when that
 * differs), where, which Google calendar, who shared it, and whether that calendar is up to date. Its
 * owner (S34) also sees the change waiting for Google or the conflict to resolve, and Edit (writable
 * calendars) and Delete with its two choices; everyone else sees it read-only. One the person may not
 * see here answers the same "not found" as one that does not exist.
 */
export async function GoogleEventPage({
  home,
  eventId,
}: {
  readonly home: { readonly id: string } | null;
  readonly eventId: string;
}) {
  const homeId = home?.id ?? null;
  const [t, tg, formats, found, directory] = await Promise.all([
    getTranslations("Calendar"),
    getTranslations("GoogleCalendar"),
    getDateTimeFormats(),
    readGoogleEvent(eventId, homeId),
    homeId ? getHomeDirectory(homeId) : Promise.resolve(null),
  ]);
  if (found.status === "not-found" || found.status === "invalid") {
    return <ErrorState title={t("notFoundTitle")} description={t("notFound")} />;
  }
  if (found.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const event = found.value;
  const zone = event.displayTimezone;
  const ownZone = !event.allDay && event.timezone !== zone;
  const sharedName =
    event.sharedBy && directory?.status === "ok"
      ? (directory.members.find((m) => m.membershipId === event.sharedBy)?.name ?? null)
      : null;
  const upToDate = event.state === "synced";
  const owner = event.kind === "personal" && event.revision !== null;
  const conflict = event.change?.state === "conflict";
  const note = [
    event.privateInGoogle ? tg("privateInGoogle") : null,
    owner ? (event.editable ? null : tg("readOnlyCalendar")) : tg("readOnly"),
  ]
    .filter((part) => part !== null)
    .join(" ");

  return (
    <>
      <PageHeader title={event.title || t("untitledGoogle")} />
      <p className="mb-4">
        <Link
          href={calendarPath(homeId)}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToCalendar")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-4" data-testid="google-event-page">
        {!upToDate ? (
          <p
            className="rounded-card border border-warning bg-surface px-4 py-3 text-body"
            role="status"
            data-testid="google-event-state"
          >
            {tg(`warning_${event.state}`)}{" "}
            {event.lastSyncedAt
              ? tg("lastSynced", { when: formatDateTime(event.lastSyncedAt, formats) })
              : tg("neverSynced")}
            {event.kind === "personal" ? (
              <>
                {" "}
                <Link href={settingsPath} className="font-medium text-accent-fg underline">
                  {tg("openSettings")}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {owner && event.change ? (
          <GoogleChangePanel change={event.change} calendar={event.calendar} />
        ) : null}
        <Card>
          <dl className="grid gap-x-6 gap-y-3 text-body sm:grid-cols-[auto_1fr]">
            <dt className="font-medium text-fg-muted">{t("when")}</dt>
            <dd data-testid="event-when">
              {whenText(event, zone, formats, t)}
              {ownZone ? (
                <span className="block text-helper text-fg-muted">
                  {t("inOwnZone", {
                    when: whenText(event, event.timezone, formats, t),
                    zone: event.timezone,
                  })}
                </span>
              ) : null}
              {event.tentative ? (
                <span className="block text-helper text-fg-muted">{tg("tentative")}</span>
              ) : null}
            </dd>
            {event.location ? (
              <>
                <dt className="font-medium text-fg-muted">{t("fieldLocation")}</dt>
                <dd>
                  <bdi>{event.location}</bdi>
                </dd>
              </>
            ) : null}
            <dt className="font-medium text-fg-muted">{tg("calendarLabel")}</dt>
            <dd data-testid="google-event-calendar">
              <bdi>{event.calendar}</bdi>
              {event.recurring ? (
                <span className="block text-helper text-fg-muted">{t("repeats")}</span>
              ) : null}
            </dd>
            {event.kind === "shared" ? (
              <>
                <dt className="font-medium text-fg-muted">{t("owner")}</dt>
                <dd data-testid="event-shared-by">
                  {sharedName ? t("sharedBy", { name: sharedName }) : t("sharedByFormer")}
                </dd>
              </>
            ) : null}
          </dl>
          {event.description ? (
            <p className="mt-4 whitespace-pre-line text-body">
              <bdi>{event.description}</bdi>
            </p>
          ) : null}
          {note ? <p className="mt-4 text-helper text-fg-muted">{note}</p> : null}
          {event.link ? (
            <a
              href={event.link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex min-h-10 items-center text-body font-medium text-accent-fg underline"
            >
              {tg("openInGoogle")}
              <span className="sr-only"> {tg("newTab")}</span>
            </a>
          ) : null}
        </Card>
        {owner && event.revision !== null ? (
          <GoogleEventActions
            homeId={homeId}
            eventId={event.eventId}
            revision={event.revision}
            recurring={event.recurring}
            editable={event.editable}
            calendar={event.calendar}
            conflict={conflict}
            dateFormat={formats.dateFormat}
            editHref={`${googleEventPath(null, event.eventId)}/edit`}
          />
        ) : null}
      </div>
    </>
  );
}
