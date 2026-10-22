import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ErrorState } from "@/components/ui/states";
import { AbsenceReviewPage } from "@/components/vacations/absences-page";
import { pageTitle } from "@/i18n/page-title";

interface HomeAbsencePageProps {
  readonly params: Promise<{ readonly homeId: string; readonly absenceId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Vacations");
  return { title: await pageTitle(t("absenceTitle")) };
}

/** One absence's affected chores (S22): its member and chore managers only. */
export default async function HomeAbsencePage({ params }: HomeAbsencePageProps) {
  const { userId } = await requireIdentity();
  const { homeId, absenceId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <AbsenceReviewPage
        home={{ id: context.home.id, name: context.home.name }}
        absenceId={absenceId}
      />
    </>
  );
}
