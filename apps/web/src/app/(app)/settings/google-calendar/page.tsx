import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import {
  CalendarChoicesForm,
  DisconnectButton,
  SyncNowButton,
} from "@/components/google-calendar/google-calendar-actions";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { GOOGLE_CONNECT_ENDPOINT } from "@/google-calendar/api";
import { readGoogleConnection } from "@/google-calendar/data";
import { connectNotice, type ConnectNotice } from "@/google-calendar/schema";
import { getGoogleCalendarServer } from "@/google-calendar/server";
import type { GoogleConnection } from "@/google-calendar/shapes";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("GoogleCalendar");
  return { title: await pageTitle(t("pageTitle")) };
}

interface GoogleCalendarSettingsPageProps {
  readonly searchParams: Promise<{ readonly google?: string }>;
}

const noticeTone: Record<ConnectNotice, "success" | "info" | "error"> = {
  connected: "success",
  reconnected: "success",
  replaced: "success",
  cancelled: "info",
  missing_scope: "error",
  state: "error",
  failed: "error",
  unavailable: "error",
};

/**
 * Google Calendar settings (S33): connect, the account and its sync state, Sync now, Reconnect,
 * Disconnect, and each calendar's choices (sync, personal calendar, Homes). Read with the person's own
 * session: the database answers only their own connection. Every action is checked again on the server.
 */
export default async function GoogleCalendarSettingsPage({
  searchParams,
}: GoogleCalendarSettingsPageProps) {
  await requireIdentity();
  const configured = getGoogleCalendarServer() !== null;
  const [t, params, formats, result] = await Promise.all([
    getTranslations("GoogleCalendar"),
    searchParams,
    getDateTimeFormats(),
    configured ? readGoogleConnection() : Promise.resolve(null),
  ]);
  const notice = connectNotice(params.google);

  return (
    <>
      <PageHeader title={t("pageTitle")} />
      <p className="mb-4">
        <Link href="/settings" className="text-body font-medium text-accent-fg underline">
          {t("backToSettings")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <p className="text-body text-fg-muted">{t("intro")}</p>
        {notice ? (
          <div data-testid="google-notice" data-notice={notice}>
            <FormAlert tone={noticeTone[notice]}>{t(`notice_${notice}`)}</FormAlert>
          </div>
        ) : null}
        {!configured ? (
          <Card title={t("notAvailableTitle")}>
            <p className="text-body" data-testid="google-not-available">
              {t("notAvailable")}
            </p>
          </Card>
        ) : result === null || result.status !== "ok" ? (
          <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
        ) : result.value === null ? (
          <Card title={t("connectTitle")} description={t("connectHint")}>
            <ConnectForm label={t("connect")} />
          </Card>
        ) : (
          <Connected connection={result.value} formats={formats} t={t} />
        )}
      </div>
    </>
  );
}

function ConnectForm({ label }: { readonly label: string }) {
  return (
    <form method="post" action={GOOGLE_CONNECT_ENDPOINT}>
      <button
        type="submit"
        className="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-body font-medium text-on-accent hover:bg-accent-hover"
        data-testid="google-connect"
      >
        {label}
      </button>
    </form>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<"GoogleCalendar">>>;

function Connected({
  connection,
  formats,
  t,
}: {
  readonly connection: GoogleConnection;
  readonly formats: DateTimeFormats;
  readonly t: Translate;
}) {
  const expired = connection.status === "authorization_expired";
  const synced = connection.calendars.filter((c) => c.sync).length;
  const canSyncMore = synced < connection.limits.syncedCalendars;
  return (
    <>
      <Card title={t("accountTitle")}>
        <div className="flex flex-col gap-3" data-testid="google-connection">
          <p className="text-body">
            {t("connectedAs")} <bdi className="font-medium">{connection.account}</bdi>
          </p>
          <p className="text-body text-fg-muted" data-testid="google-last-sync">
            {connection.syncQueued
              ? t("syncing")
              : connection.lastSyncedAt
                ? t("lastSynced", { when: formatDateTime(connection.lastSyncedAt, formats) })
                : t("neverSynced")}
          </p>
          {expired ? (
            <div data-testid="google-expired">
              <FormAlert tone="error">{t("expired")}</FormAlert>
            </div>
          ) : connection.errorCode ? (
            <FormAlert tone="info">{t("lastSyncFailed")}</FormAlert>
          ) : null}
          <div className="flex flex-wrap items-start gap-3">
            {expired ? (
              <ConnectForm label={t("reconnect")} />
            ) : (
              <SyncNowButton disabled={!connection.canSyncNow} />
            )}
            <DisconnectButton />
          </div>
        </div>
      </Card>
      <Card title={t("calendarsTitle")} description={t("calendarsHint")}>
        {!connection.listed ? (
          <p className="text-body text-fg-muted">{t("calendarsPending")}</p>
        ) : connection.calendars.length === 0 ? (
          <p className="text-body text-fg-muted">{t("calendarsNone")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {connection.calendars.map((calendar) => (
              <li key={calendar.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                <h3 className="text-body font-medium text-fg">
                  <bdi>{calendar.name}</bdi>
                  {calendar.primary ? ` (${t("primary")})` : ""}
                </h3>
                {!calendar.available ? (
                  <p className="text-helper text-fg-muted">{t("calendarUnavailable")}</p>
                ) : calendar.accessRole === "freeBusyReader" ? (
                  <p className="text-helper text-fg-muted">{t("calendarFreeBusy")}</p>
                ) : (
                  <>
                    {calendar.sync && calendar.state && calendar.state !== "synced" ? (
                      <p className="text-helper text-fg-muted">{t(`warning_${calendar.state}`)}</p>
                    ) : null}
                    <CalendarChoicesForm
                      calendarId={calendar.id}
                      name={calendar.name}
                      sync={calendar.sync}
                      showPersonal={calendar.showPersonal}
                      shared={calendar.homes}
                      homes={connection.homes}
                      canSync={canSyncMore}
                    />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {!canSyncMore ? (
          <p className="mt-3 text-helper text-fg-muted">
            {t("limitReached", { count: connection.limits.syncedCalendars })}
          </p>
        ) : null}
      </Card>
    </>
  );
}
