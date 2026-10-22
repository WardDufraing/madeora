import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { RewardsPage } from "@/components/points/rewards-page";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeRewardsPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Rewards");
  return { title: await pageTitle(t("title")) };
}

/** A Home's rewards (S23): every member redeems; reviewers and rewards managers act here. */
export default async function HomeRewardsPage({ params }: HomeRewardsPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <RewardsPage home={{ id: context.home.id, name: context.home.name }} focus="catalog" />
    </>
  );
}
