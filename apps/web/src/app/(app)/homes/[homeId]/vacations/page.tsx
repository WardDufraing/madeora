import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ErrorState } from "@/components/ui/states";
import { VacationsPage } from "@/components/vacations/vacations-page";
import { pageTitle } from "@/i18n/page-title";

interface HomeVacationsPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Vacations");
  return { title: await pageTitle(t("title")) };
}

/** A Home's vacations (S22): every member sees them and records their own. */
export default async function HomeVacationsPage({ params }: HomeVacationsPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <VacationsPage home={{ id: context.home.id, name: context.home.name }} />
    </>
  );
}
