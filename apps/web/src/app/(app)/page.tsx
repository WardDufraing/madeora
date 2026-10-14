import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { HomeSetupCard } from "@/components/dashboard/home-setup-card";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { getStoredPreferences } from "@/preferences/account";
import { formatDate, formatWeekday, isoDate } from "@/preferences/regional";
import { getEffectiveTimeZone, getRegionalFormats } from "@/preferences/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Nav");
  return { title: await pageTitle(t("dashboard")) };
}

/**
 * The personal dashboard: the starting point for every adult, with or without Homes (spec,
 * "Confirmed Home-independent adult account onboarding", "Confirmed editable starter personal
 * dashboard"). Widgets arrive with S17 and the modules; until then the widget area says so
 * honestly. Homes arrive with S09, so everyone is in the Personal context with zero Homes here.
 */
export default async function DashboardPage() {
  await requireIdentity();
  const [t, tNav, locale, stored, { timeZone, source }, { effective }] = await Promise.all([
    getTranslations("Dashboard"),
    getTranslations("Nav"),
    getLocale(),
    getStoredPreferences(),
    getEffectiveTimeZone(),
    getRegionalFormats(),
  ]);
  const now = new Date();

  return (
    <>
      <PageHeader title={tNav("dashboard")} />
      <div className="mb-6 flex flex-col gap-1">
        <p className="text-section-title font-semibold text-fg">
          {stored.displayName
            ? // The name is isolated (FSI … PDI, like <bdi>), so a name written right to left
              // cannot reorder the words around it.
              t("greetingNamed", { name: `\u2068${stored.displayName}\u2069` })
            : t("greeting")}
        </p>
        <p className="text-body text-fg-muted">
          <time dateTime={isoDate(now, timeZone)} data-time-zone={timeZone} data-testid="today">
            {t("today", {
              weekday: formatWeekday(now, timeZone, locale),
              date: formatDate(now, timeZone, effective.dateFormat),
            })}
          </time>
          {/* Until this device has reported its timezone, say which one the date is in. */}
          {source === "fallback" ? ` ${t("todayFallbackZone", { zone: timeZone })}` : null}
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card title={t("widgetsTitle")}>
          <EmptyState title={t("widgetsEmptyTitle")} description={t("widgetsEmptyDescription")} />
        </Card>
        <HomeSetupCard />
      </div>
    </>
  );
}
