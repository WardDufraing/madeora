import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { DashboardSection } from "@/components/dashboard/dashboard-section";
import { HomeSetupCard } from "@/components/dashboard/home-setup-card";
import { RememberContext } from "@/components/homes/remember-context";
import { RecoveredHomesNotice } from "@/components/recovery/recovered-homes-notice";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/ui/states";
import { getHomeContext, getRememberedContext, listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getStoredPreferences } from "@/preferences/account";
import { getDateTimeFormats } from "@/invitations/server";
import { getEffectiveTimeZone } from "@/preferences/server";

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
 * dashboard"). Its widgets are the person's own layout (S17), or the starter layout until they
 * customize it; Home setup stays outside the widgets until the person has a Home.
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

  const [t, tNav, stored, { source }, formats, myHomes] = await Promise.all([
    getTranslations("Dashboard"),
    getTranslations("Nav"),
    getStoredPreferences(),
    getEffectiveTimeZone(),
    getDateTimeFormats(),
    listMyHomes(),
  ]);
  const now = new Date();
  const homes = myHomes.status === "ok" ? myHomes.homes : [];
  const hasHomes = homes.length > 0;

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
      <RecoveredHomesNotice now={now} />
      <div className="flex flex-col gap-6">
        {/* Outside the widgets, so it is never part of a layout and goes away once there is a Home. */}
        {hasHomes ? null : <HomeSetupCard />}
        <DashboardSection
          scope={{
            kind: "personal",
            displayName: stored.displayName,
            formats,
            timeZoneIsFallback: source === "fallback",
            homes,
          }}
          emptyState={<EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />}
        />
      </div>
    </>
  );
}
