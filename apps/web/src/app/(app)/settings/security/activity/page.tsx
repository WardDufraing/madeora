import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { parseActivityCursor, parseActivityFilters } from "@/activity/filters";
import { listMyActivity, listMySecurityReports } from "@/activity/server";
import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { ActivityFiltersForm } from "@/components/activity/activity-filters";
import { ActivityList } from "@/components/activity/activity-list";
import { SecurityReportSetting } from "@/components/activity/security-report-setting";
import { FormAlert } from "@/components/auth/form-alert";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { formatDate } from "@/preferences/regional";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Activity");
  return { title: await pageTitle(t("securityTitle")) };
}

interface SecurityActivityPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PATH = "/settings/security/activity";
const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD of `instant` in `timeZone`. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Settings › Security › Security activity (S38, spec "Confirmed adult account security activity
 * history"): the Security part of the person's own history, the controls to answer an unfamiliar
 * sign-in, and the downloadable security report. Only the account holder can see it.
 */
export default async function SecurityActivityPage({ searchParams }: SecurityActivityPageProps) {
  await requireIdentity();
  const [t, params, formats, user, security, reports] = await Promise.all([
    getTranslations("Activity"),
    searchParams,
    getDateTimeFormats(),
    getVerifiedUser(),
    getAccountSecurity(),
    listMySecurityReports(),
  ]);
  if (!user) return null;
  const filters = { ...parseActivityFilters(params), category: "" as const, home: "" };
  const cursor = parseActivityCursor(params);
  const page = await listMyActivity({
    filters,
    cursor,
    timeZone: formats.timeZone,
    scope: "security",
  });
  const hasPassword = security.status === "ok" ? security.value.hasPassword : true;
  const confirmed = parseAccountChangeAction(params.confirmed);
  const now = new Date();
  // A day of margin inside the 12-month retention, so a range chosen now is still valid when sent.
  const earliestInstant = new Date(now);
  earliestInstant.setUTCFullYear(earliestInstant.getUTCFullYear() - 1);
  const earliest = localDate(new Date(earliestInstant.getTime() + DAY_MS), formats.timeZone);
  const today = localDate(now, formats.timeZone);
  const defaultFrom = localDate(new Date(now.getTime() - 30 * DAY_MS), formats.timeZone);
  const day = (isoDate: string) =>
    formatDate(new Date(`${isoDate}T12:00:00Z`), "UTC", formats.dateFormat);

  return (
    <>
      <PageHeader title={t("securityTitle")} />
      <p className="mb-2 max-w-2xl text-body text-fg-muted">{t("securityHint")}</p>
      <p className="mb-4 flex flex-wrap gap-4">
        <Link href="/settings/security" className="text-body font-medium text-accent-fg underline">
          {t("securityBack")}
        </Link>
        <Link
          href="/settings/security/notifications"
          className="text-body font-medium text-accent-fg underline"
        >
          {t("alertsLink")}
        </Link>
      </p>
      <div className="flex max-w-3xl flex-col gap-6">
        <FormAlert tone="info">{t("unfamiliarHint")}</FormAlert>
        <Card>
          <ActivityFiltersForm action={PATH} filters={filters} homes={[]} securityOnly />
          <ActivityList
            path={PATH}
            page={page.status === "ok" ? page.value : null}
            filters={filters}
            paged={cursor !== null}
            formats={formats}
            securityOnly
          />
        </Card>
        <div id="report" className="scroll-mt-20">
          <Card title={t("reportTitle")} description={t("reportHint")}>
            {reports.status === "unavailable" ? (
              <FormAlert tone="error">{t("unavailableHint")}</FormAlert>
            ) : null}
            <SecurityReportSetting
              email={user.email ?? ""}
              userId={user.id}
              twoFactor={verifiedTotpFactor(user) !== null}
              hasPassword={hasPassword}
              confirmed={confirmed}
              timeZone={formats.timeZone}
              today={today}
              earliest={earliest}
              defaultFrom={defaultFrom < earliest ? earliest : defaultFrom}
              reports={
                reports.status === "ok"
                  ? reports.value.map((report) => ({
                      id: report.id,
                      range: t("reportRange", { from: day(report.from), to: day(report.to) }),
                      status: report.status,
                      expires: formatDateTime(report.expiresAt, formats),
                      downloaded: report.downloadedAt
                        ? formatDateTime(report.downloadedAt, formats)
                        : null,
                    }))
                  : []
              }
            />
          </Card>
        </div>
      </div>
    </>
  );
}
