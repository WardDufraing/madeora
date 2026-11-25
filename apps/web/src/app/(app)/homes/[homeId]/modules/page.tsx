import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { AllModules } from "@/components/shell/all-modules";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Modules");
  return { title: await pageTitle(t("title")) };
}

/**
 * Every module in a Home, for its current members. A Home the person is not (or no longer) in
 * shows the same neutral notice as every other Home page.
 */
export default async function HomeModulesPage({ params }: PageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Modules"),
    getTranslations("Homes"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <PageHeader title={t("title")} />
      <p className="-mt-4 mb-6 max-w-prose text-body text-fg-muted">
        {t("description", { context: t("contextHome") })}
      </p>
      <AllModules homeId={context.home.id} />
    </>
  );
}
