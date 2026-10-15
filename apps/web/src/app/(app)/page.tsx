import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { HomeSetupCard } from "@/components/dashboard/home-setup-card";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { getHomeContext, getRememberedContext, listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getStoredPreferences } from "@/preferences/account";
import { formatDate, formatWeekday, isoDate } from "@/preferences/regional";
import { getEffectiveTimeZone, getRegionalFormats } from "@/preferences/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Nav");
  return { title: await pageTitle(t("dashboard")) };
}

interface DashboardPageProps {
  readonly searchParams: Promise<{
    readonly context?: string | string[];
    readonly notice?: string | string[];
  }>;
}

/**
 * The personal dashboard: the starting point for every adult, with or without Homes (spec,
 * "Confirmed Home-independent adult account onboarding", "Confirmed editable starter personal
 * dashboard"). Widgets arrive with S17 and the modules; until then the widget area says so
 * honestly.
 *
 * Opening `/` returns to the Home this device used last, if the person still belongs to it (S09);
 * `?context=personal` (the switcher's Personal link) stays here and makes Personal the default
 * again. `?notice=home-unavailable` explains, without saying why, that a Home could not be opened;
 * `?notice=home-left` confirms that the person left a Home (S12), without naming it.
 */
export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const { userId } = await requireIdentity();
  const params = await searchParams;
  const notice =
    params.notice === "home-unavailable" || params.notice === "home-left" ? params.notice : null;
  if (params.context !== "personal" && notice === null) {
    const remembered = await getRememberedContext(userId);
    if (remembered?.kind === "home") {
      const found = await getHomeContext(remembered.homeId);
      if (found.status === "ok") redirect(`/homes/${found.context.home.id}`);
    }
  }

  const [t, tNav, locale, stored, { timeZone, source }, { effective }] = await Promise.all([
    getTranslations("Dashboard"),
    getTranslations("Nav"),
    getLocale(),
    getStoredPreferences(),
    getEffectiveTimeZone(),
    getRegionalFormats(),
  ]);
  const myHomes = await listMyHomes();
  const now = new Date();
  const hasHomes = myHomes.status === "ok" && myHomes.homes.length > 0;

  return (
    <>
      <RememberContext
        userId={userId}
        context={{ kind: "personal" }}
        clearParams={["context", "notice"]}
      />
      <PageHeader title={tNav("dashboard")} />
      {notice ? (
        <FormAlert tone="info" announce className="mb-6">
          {notice === "home-left" ? t("leftHome") : t("homeUnavailable")}
        </FormAlert>
      ) : null}
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
      <div
        className={
          hasHomes
            ? "grid items-start gap-6"
            : "grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
        }
      >
        <Card title={t("widgetsTitle")}>
          <EmptyState title={t("widgetsEmptyTitle")} description={t("widgetsEmptyDescription")} />
        </Card>
        {hasHomes ? null : <HomeSetupCard />}
      </div>
    </>
  );
}
