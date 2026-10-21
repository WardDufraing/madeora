import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { ChoreSummaryPage } from "@/components/chores/chore-summary-page";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeChoreSummaryPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Chores");
  return { title: await pageTitle(t("summaryTitle")) };
}

/** A chore manager's daily summary of a Home (S21), with the setting for its notification. */
export default async function HomeChoreSummaryPage({ params }: HomeChoreSummaryPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <ChoreSummaryPage home={{ id: context.home.id, name: context.home.name }} />
    </>
  );
}
