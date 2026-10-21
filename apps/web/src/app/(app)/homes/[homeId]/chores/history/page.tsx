import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { HomeHistoryPage } from "@/components/chores/home-history-page";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { advanceChores } from "@/chores/data";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeChoreHistoryPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Chores");
  return { title: await pageTitle(t("homeHistoryTitle")) };
}

/** A Home's searchable chore history (S20): every current member of the Home. */
export default async function HomeChoreHistoryPage({
  params,
  searchParams,
}: HomeChoreHistoryPageProps) {
  const { userId } = await requireIdentity();
  const [{ homeId }, query] = await Promise.all([params, searchParams]);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  await advanceChores(context.home.id);
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <HomeHistoryPage
        userId={userId}
        home={{ id: context.home.id, name: context.home.name, timeZone: context.home.timeZone }}
        searchParams={query}
      />
    </>
  );
}
