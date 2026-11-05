import { getTranslations } from "next-intl/server";

import { localDateTime } from "@/calendar/time";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { readGoogleEvent } from "@/google-calendar/data";
import { getDateTimeFormats } from "@/invitations/server";
import { timeZoneChoices } from "@/preferences/timezone";

import { GoogleEventForm, type GoogleEventValues } from "./google-event-form";

/**
 * The edit page of one of the person's own Google events (S34), in a calendar Madeora may write to and
 * with no conflict waiting; the database checks all of it again. Times start in the event's own zone.
 */
export async function GoogleEditPage({ eventId }: { readonly eventId: string }) {
  const [t, formats, found] = await Promise.all([
    getTranslations("Calendar"),
    getDateTimeFormats(),
    readGoogleEvent(eventId, null),
  ]);
  if (found.status === "not-found" || found.status === "invalid") {
    return <ErrorState title={t("notFoundTitle")} description={t("notFound")} />;
  }
  if (found.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const event = found.value;
  if (
    event.kind !== "personal" ||
    event.revision === null ||
    !event.editable ||
    event.change?.state === "conflict"
  ) {
    return <ErrorState title={t("notPermittedTitle")} description={t("notPermitted")} />;
  }
  const zone = event.timezone;
  const start = event.startsAt ? localDateTime(event.startsAt, zone) : null;
  const end = event.endsAt ? localDateTime(event.endsAt, zone) : null;
  const values: GoogleEventValues = {
    title: event.title,
    location: event.location ?? "",
    description: event.description ?? "",
    allDay: event.allDay,
    startsOn: event.allDay ? (event.startsOn ?? event.from) : (start?.date ?? event.from),
    endsOn: event.allDay ? (event.endsOn ?? event.to) : (end?.date ?? event.to),
    startTime: start?.time ?? "09:00",
    endTime: end?.time ?? "10:00",
    timezone: zone,
  };
  return (
    <>
      <PageHeader title={t("editEventTitle")} />
      <GoogleEventForm
        eventId={event.eventId}
        revision={event.revision}
        recurring={event.recurring}
        values={values}
        timeZoneChoices={timeZoneChoices([event.displayTimezone, zone])}
        dateFormat={formats.dateFormat}
      />
    </>
  );
}
