import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { DisplayConfigEditor } from "@/components/displays/display-config-editor";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getHouseholdDisplayConfig, getHouseholdDisplays } from "@/displays/server";
import { pageTitle } from "@/i18n/page-title";

interface DisplayConfigPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly displayId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("DisplayConfig");
  return { title: await pageTitle(t("title")) };
}

/**
 * Home → Household Displays → one display (S44; spec "Confirmed independent layouts for each
 * Household Display"): its privacy/party lock and its own layout and presentation. Same managers
 * as pairing (Owner, or Administrator with manageHomeSettings); everyone else is told the page is
 * not for them, and the API and the database check again on every change.
 */
export default async function DisplayConfigPage({ params }: DisplayConfigPageProps) {
  const { userId } = await requireIdentity();
  const { homeId, displayId } = await params;
  const [context, t, tDisplays, tHomes] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("DisplayConfig"),
    getTranslations("Displays"),
    getTranslations("Homes"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, permissions } = context;
  const manager = permissions["home.updateSettings"];
  const [displays, config] = manager
    ? await Promise.all([
        getHouseholdDisplays(home.id),
        getHouseholdDisplayConfig(home.id, displayId),
      ])
    : [null, null];
  const display = displays?.find((item) => item.id === displayId && item.status === "active");

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={display ? display.name : t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}/displays`} className="font-medium text-accent-fg underline">
          {tDisplays("title")}
        </Link>
      </p>
      {!manager ? (
        <EmptyState title={tDisplays("notManagerTitle")} description={tDisplays("notManager")} />
      ) : !display || !config ? (
        <ErrorState title={t("notFoundTitle")} description={t("notFound")} />
      ) : (
        <Card className="max-w-2xl">
          <DisplayConfigEditor
            homeId={home.id}
            displayId={display.id}
            displayName={display.name}
            config={config}
          />
        </Card>
      )}
    </>
  );
}
