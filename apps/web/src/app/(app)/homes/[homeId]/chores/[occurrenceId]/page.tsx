import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { ChoreDetailPage } from "@/components/chores/chore-detail";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeChorePageProps {
  readonly params: Promise<{ readonly homeId: string; readonly occurrenceId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Chores");
  return { title: await pageTitle(t("chorePageTitle")) };
}

/**
 * One chore occurrence (S20). The Home is checked first: a Home the person is not in sends them to
 * Personal with the neutral notice; an occurrence they cannot see, or of another Home, is not found.
 */
export default async function HomeChorePage({ params }: HomeChorePageProps) {
  const { userId } = await requireIdentity();
  const { homeId, occurrenceId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <ChoreDetailPage userId={userId} homeId={context.home.id} occurrenceId={occurrenceId} />
    </>
  );
}
