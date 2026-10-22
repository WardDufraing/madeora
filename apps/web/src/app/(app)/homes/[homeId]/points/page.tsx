import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { PointsPage } from "@/components/points/points-page";
import { ErrorState } from "@/components/ui/states";
import { advanceChores } from "@/chores/data";
import { pageTitle } from "@/i18n/page-title";

interface HomePointsPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Points");
  return { title: await pageTitle(t("pageTitle")) };
}

/** A Home's points (S23): every member sees their own; points managers see every account. */
export default async function HomePointsPage({ params, searchParams }: HomePointsPageProps) {
  const { userId } = await requireIdentity();
  const [{ homeId }, query] = await Promise.all([params, searchParams]);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  await advanceChores(context.home.id);
  const account = z.uuid().safeParse(query.account);
  const before = z.coerce.number().int().min(1).safeParse(query.before);
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <PointsPage
        home={{ id: context.home.id, name: context.home.name }}
        accountId={account.success ? account.data : null}
        before={before.success ? before.data : null}
      />
    </>
  );
}
