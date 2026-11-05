import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { readUpcoming } from "@/calendar/data";
import { calendarHref, clockTime, newEventPath, occurrencePath } from "@/calendar/format";
import { GoogleWarnings } from "@/components/google-calendar/google-warnings";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import type { DateTimeFormats } from "@/invitations/format";
import { getHomeDirectory } from "@/members/directory";
import { formatTaskDate } from "@/tasks/format";

/**
 * The Upcoming events widget (S32; PS L427): the next occurrences of its context within the chosen
 * days. Personal: the viewer's own events; a Home (its own dashboard or bound on the personal one):
 * Home events and personal events shared with it. Read with the viewer's session, so nobody's
 * unshared event, nor any sign of it, ever appears.
 */
export async function UpcomingEventsWidget({
  home,
  config,
  formats,
}: {
  readonly home: { readonly id: string; readonly name: string } | null;
  readonly config: WidgetConfigs["upcoming-events"];
  readonly formats: DateTimeFormats;
}) {
  const homeId = home?.id ?? null;
  const t = await getTranslations("Calendar");
  const [upcoming, directory] = await Promise.all([
    readUpcoming(homeId, config.days, config.count),
    homeId ? getHomeDirectory(homeId) : Promise.resolve(null),
  ]);
  if (upcoming.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  const value = upcoming.value;
  const names = new Map(
    directory?.status === "ok"
      ? directory.members.map((member) => [member.membershipId, member.name])
      : [],
  );
  const add = value.canCreate ? (
    <Link
      href={newEventPath(homeId)}
      className="text-body font-medium text-accent-fg underline"
      data-testid="upcoming-add-event"
    >
      {t("addEvent")}
    </Link>
  ) : null;
  if (value.occurrences.length === 0) {
    // A Google calendar that is not up to date is named even here: "nothing ahead" may not be true.
    return (
      <div className="flex flex-col gap-3">
        <GoogleWarnings warnings={value.googleWarnings} names={names} formats={formats} compact />
        <EmptyState
          title={t("widgetEmptyTitle")}
          description={t("widgetEmpty", { days: config.days })}
          action={add}
        />
      </div>
    );
  }
  const date = (day: string) => formatTaskDate(day, formats);
  return (
    <div className="flex flex-col gap-3">
      <GoogleWarnings warnings={value.googleWarnings} names={names} formats={formats} compact />
      <ul className="flex flex-col gap-2" data-testid="upcoming-events">
        {value.occurrences.map((occurrence) => {
          const when =
            occurrence.allDay || !occurrence.startsAt
              ? t("upcomingAllDay", { date: date(occurrence.from) })
              : t("upcomingTimed", {
                  date: date(occurrence.from),
                  time: clockTime(occurrence.startsAt, value.timezone, formats),
                });
          const sharedName = occurrence.sharedBy ? names.get(occurrence.sharedBy) : null;
          return (
            <li key={`${occurrence.eventId}:${occurrence.on ?? ""}`} className="text-body">
              <Link
                href={occurrencePath(homeId, occurrence)}
                className="flex flex-col underline-offset-2 hover:underline"
              >
                <bdi className="font-medium text-fg">{occurrence.title || t("untitledGoogle")}</bdi>
                <span className="text-helper text-fg-muted">
                  {when}
                  {occurrence.source === "google"
                    ? ` · ${t("fromGoogle", { calendar: occurrence.calendar ?? "" })}`
                    : ""}
                  {occurrence.kind === "shared"
                    ? ` · ${sharedName ? t("sharedBy", { name: sharedName }) : t("sharedByFormer")}`
                    : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {value.more ? (
          <Link
            href={calendarHref(homeId, "agenda")}
            className="text-body font-medium text-accent-fg underline"
          >
            {t("widgetMore")}
          </Link>
        ) : null}
        {add}
      </div>
    </div>
  );
}
