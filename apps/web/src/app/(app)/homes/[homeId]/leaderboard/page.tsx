import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { leaderboardPeriods } from "@madeora/domain/points";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { LeaderboardPage } from "@/components/points/leaderboard-page";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { z } from "zod";

interface HomeLeaderboardPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Points");
  return { title: await pageTitle(t("leaderboardTitle")) };
}

/** A Home's leaderboard (S23), when the Home turned it on; its settings for rewards managers. */
export default async function HomeLeaderboardPage({
  params,
  searchParams,
}: HomeLeaderboardPageProps) {
  const { userId } = await requireIdentity();
  const [{ homeId }, query] = await Promise.all([params, searchParams]);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const period = z.enum(leaderboardPeriods).safeParse(query.period);
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <LeaderboardPage
        home={{ id: context.home.id, name: context.home.name }}
        period={period.success ? period.data : null}
      />
    </>
  );
}
