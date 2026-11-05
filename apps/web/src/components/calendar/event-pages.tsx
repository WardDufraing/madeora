import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { readCalendar, readEvent } from "@/calendar/data";
import { calendarPath, clockTime, editEventPath } from "@/calendar/format";
import type { EventDetail } from "@/calendar/shapes";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { dateOnlySchema } from "@/tasks/schema";
import type { DateTimeFormats } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { listMyHomes } from "@/homes/server";
import { getHomeDirectory } from "@/members/directory";
import { getEffectiveTimeZone } from "@/preferences/server";
import { isoDate } from "@/preferences/regional";
import { timeZoneChoices } from "@/preferences/timezone";
import { formatTaskDate } from "@/tasks/format";

import { EventActions } from "./event-actions";
import { EventForm } from "./event-form";
import { RepeatSummary } from "./repeat-summary";
import { ShareForm } from "./share-form";

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** The `on` date of an occurrence address, when it is a date. */
export function occurrenceParam(searchParams: SearchParams, key = "on"): string | null {
  const value = searchParams[key];
  const parsed = dateOnlySchema.safeParse(typeof value === "string" ? value : undefined);
  return parsed.success ? parsed.data : null;
}

export interface EventContext {
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string } | null;
}

async function NotFound() {
  const t = await getTranslations("Calendar");
  return <ErrorState title={t("notFoundTitle")} description={t("notFound")} />;
}

async function Failed() {
  const t = await getTranslations("Calendar");
  return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
}

function whenText(
  source: NonNullable<EventDetail["occurrence"]> | EventDetail["series"],
  timeZone: string,
  formats: DateTimeFormats,
  t: Awaited<ReturnType<typeof getTranslations<"Calendar">>>,
): string {
  const date = (value: string) => formatTaskDate(value, formats);
  if (source.allDay || !source.startsAt || !source.endsAt) {
    return source.from === source.to
      ? t("whenAllDay", { date: date(source.from) })
      : t("whenAllDayRange", { from: date(source.from), to: date(source.to) });
  }
  const start = clockTime(source.startsAt, timeZone, formats);
  const end = clockTime(source.endsAt, timeZone, formats);
  return source.from === source.to
    ? t("whenTimed", { date: date(source.from), start, end })
    : t("whenTimedRange", { from: date(source.from), start, to: date(source.to), end });
}

/**
 * One event's page (S32): what, when (in the context's timezone, and in the event's own when that
 * differs), where, who takes part, how it repeats, and, for its owner, which Homes see it. Edit and
 * Delete only where the person may. An event the person may not see here answers the same "not
 * found" as one that does not exist.
 */
export async function EventPage({
  home,
  eventId,
  searchParams,
}: EventContext & { readonly eventId: string; readonly searchParams: SearchParams }) {
  const homeId = home?.id ?? null;
  const on = occurrenceParam(searchParams);
  const [t, formats, found, directory, homes] = await Promise.all([
    getTranslations("Calendar"),
    getDateTimeFormats(),
    readEvent(eventId, homeId, on),
    homeId ? getHomeDirectory(homeId) : Promise.resolve(null),
    homeId ? Promise.resolve(null) : listMyHomes(),
  ]);
  if (found.status === "not-found" || found.status === "invalid") return <NotFound />;
  if (found.status !== "ok" || (directory && directory.status !== "ok")) return <Failed />;
  const event = found.value;
  // A recurring event's address names one occurrence; without one (or a date not in it), the series.
  const shown = event.occurrence ?? event.series;
  const names = new Map(
    directory?.status === "ok"
      ? directory.members.map((member) => [member.membershipId, member])
      : [],
  );
  const zone = event.displayTimezone;
  const ownZone = !shown.allDay && shown.timezone !== zone;
  const sharedName = event.sharedBy ? names.get(event.sharedBy)?.name : null;

  return (
    <>
      <PageHeader title={shown.title} />
      <p className="mb-4">
        <Link
          href={calendarPath(homeId)}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToCalendar")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-4" data-testid="event-page">
        <Card>
          <dl className="grid gap-x-6 gap-y-3 text-body sm:grid-cols-[auto_1fr]">
            <dt className="font-medium text-fg-muted">{t("when")}</dt>
            <dd data-testid="event-when">
              {whenText(shown, zone, formats, t)}
              {ownZone ? (
                <span className="block text-helper text-fg-muted">
                  {t("inOwnZone", {
                    when: whenText(shown, shown.timezone, formats, t),
                    zone: shown.timezone,
                  })}
                </span>
              ) : null}
            </dd>
            {shown.location ? (
              <>
                <dt className="font-medium text-fg-muted">{t("fieldLocation")}</dt>
                <dd>
                  <bdi>{shown.location}</bdi>
                </dd>
              </>
            ) : null}
            {event.repeat ? (
              <>
                <dt className="font-medium text-fg-muted">{t("repeatsLabel")}</dt>
                <dd data-testid="event-repeat">
                  <RepeatSummary
                    repeat={event.repeat}
                    startsOn={event.series.startsOn}
                    dateFormat={formats.dateFormat}
                  />
                  {shown.changed ? (
                    <span className="block text-helper text-fg-muted">
                      {t("occurrenceChanged")}
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {event.reminder !== null ? (
              <>
                <dt className="font-medium text-fg-muted">{t("fieldReminder")}</dt>
                <dd data-testid="event-reminder-shown">
                  {t("reminderBefore", { minutes: event.reminder })}
                </dd>
              </>
            ) : null}
            {event.kind === "shared" ? (
              <>
                <dt className="font-medium text-fg-muted">{t("owner")}</dt>
                <dd data-testid="event-shared-by">
                  {sharedName ? t("sharedBy", { name: sharedName }) : t("sharedByFormer")}
                  <span className="block text-helper text-fg-muted">{t("sharedReadOnly")}</span>
                </dd>
              </>
            ) : null}
            {homeId && shown.participants.length > 0 ? (
              <>
                <dt className="font-medium text-fg-muted">{t("fieldParticipants")}</dt>
                <dd>
                  <ul data-testid="event-participants-list">
                    {shown.participants.map((id) => {
                      const member = names.get(id);
                      return (
                        <li key={id}>
                          <bdi>
                            {member?.isSelf
                              ? t("memberYou", { name: member.name ?? t("memberUnnamed") })
                              : (member?.name ?? t("memberUnnamed"))}
                          </bdi>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>
          {shown.description ? (
            <p className="mt-4 whitespace-pre-line text-body">
              <bdi>{shown.description}</bdi>
            </p>
          ) : null}
        </Card>
        <EventActions
          homeId={homeId}
          eventHomeId={event.homeId}
          eventId={event.id}
          revision={event.revision}
          recurring={event.repeat !== null}
          on={event.occurrence ? (event.occurrence.on ?? null) : null}
          canEdit={event.canEdit}
          canDelete={event.canDelete}
          dateFormat={formats.dateFormat}
        />
        {event.kind === "personal" && event.shares !== null && homes?.status === "ok" ? (
          <Card title={t("shareHeading")} description={t("shareDescription")}>
            <ShareForm
              eventId={event.id}
              revision={event.revision}
              homes={homes.homes.map(({ id, name }) => ({ id, name }))}
              shared={event.shares}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}

/** The form's data: members or Homes, formats and timezone choices. */
async function formData(home: EventContext["home"]) {
  const [formats, directory, homes, personal] = await Promise.all([
    getDateTimeFormats(),
    home ? getHomeDirectory(home.id) : Promise.resolve(null),
    home ? Promise.resolve(null) : listMyHomes(),
    getEffectiveTimeZone(),
  ]);
  const timeZone = home ? home.timeZone : personal.timeZone;
  if ((directory && directory.status !== "ok") || (homes && homes.status !== "ok")) return null;
  return {
    formats,
    timeZone,
    today: isoDate(new Date(), timeZone),
    members:
      directory?.status === "ok"
        ? directory.members.map((member) => ({
            id: member.membershipId,
            name: member.name,
            isSelf: member.isSelf,
          }))
        : [],
    homes: homes?.status === "ok" ? homes.homes.map(({ id, name }) => ({ id, name })) : [],
  };
}

/** The new-event page (S32): only where the person may add events (the database decides again). */
export async function NewEventPage({
  home,
  searchParams,
}: EventContext & { readonly searchParams: SearchParams }) {
  const [t, data, allowed] = await Promise.all([
    getTranslations("Calendar"),
    formData(home),
    // Whether the person may add events here now (always in the Personal space).
    home
      ? readCalendar(
          home.id,
          isoDate(new Date(), home.timeZone),
          isoDate(new Date(), home.timeZone),
        )
      : null,
  ]);
  if (!data || (allowed && allowed.status !== "ok")) return <Failed />;
  if (allowed?.status === "ok" && !allowed.value.canCreate) {
    return <ErrorState title={t("notPermittedTitle")} description={t("notPermitted")} />;
  }
  return (
    <>
      <PageHeader title={t("newEventTitle")} />
      <p className="mb-4 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : t("personalSpace")}</bdi>
      </p>
      <EventForm
        homeId={home?.id ?? null}
        defaultTimeZone={data.timeZone}
        timeZoneChoices={timeZoneChoices([data.timeZone])}
        members={data.members}
        homes={data.homes}
        dateFormat={data.formats.dateFormat}
        initialDate={occurrenceParam(searchParams, "date") ?? data.today}
      />
    </>
  );
}

/** The edit page of an event, or of one occurrence (`?on=`). */
export async function EditEventPage({
  home,
  eventId,
  searchParams,
}: EventContext & { readonly eventId: string; readonly searchParams: SearchParams }) {
  const homeId = home?.id ?? null;
  const on = occurrenceParam(searchParams);
  const [t, data, found] = await Promise.all([
    getTranslations("Calendar"),
    formData(home),
    readEvent(eventId, homeId, on),
  ]);
  if (found.status === "not-found" || found.status === "invalid") return <NotFound />;
  if (found.status !== "ok" || !data) return <Failed />;
  const event = found.value;
  if (!event.canEdit) {
    return <ErrorState title={t("notPermittedTitle")} description={t("notPermitted")} />;
  }
  // A personal event is edited in the personal space, where its shares are (from a Home's calendar
  // the form would have none to keep).
  if (event.homeId !== homeId) redirect(editEventPath(event.homeId, event.id, on));
  const occurrenceOn =
    event.repeat && event.occurrence ? (event.occurrence.on ?? undefined) : undefined;
  return (
    <>
      <PageHeader title={t("editEventTitle")} />
      <EventForm
        homeId={homeId}
        defaultTimeZone={data.timeZone}
        timeZoneChoices={timeZoneChoices([data.timeZone, event.series.timezone])}
        members={data.members}
        homes={data.homes}
        dateFormat={data.formats.dateFormat}
        initialDate={event.series.startsOn}
        event={event}
        {...(occurrenceOn ? { on: occurrenceOn } : {})}
      />
    </>
  );
}
