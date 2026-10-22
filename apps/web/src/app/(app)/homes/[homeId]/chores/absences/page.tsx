import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ErrorState } from "@/components/ui/states";
import { AbsencesPage } from "@/components/vacations/absences-page";
import { pageTitle } from "@/i18n/page-title";

interface HomeAbsencesPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Vacations");
  return { title: await pageTitle(t("absencesTitle")) };
}

/** Temporary chore absences (S22): a member's own, and everyone's for chore managers. */
export default async function HomeAbsencesPage({ params }: HomeAbsencesPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <AbsencesPage home={{ id: context.home.id, name: context.home.name }} />
    </>
  );
}
