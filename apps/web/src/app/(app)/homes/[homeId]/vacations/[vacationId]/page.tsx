import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ErrorState } from "@/components/ui/states";
import { VacationDetailPage } from "@/components/vacations/vacation-detail-page";
import { pageTitle } from "@/i18n/page-title";

interface HomeVacationPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly vacationId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Vacations");
  return { title: await pageTitle(t("detailTitle")) };
}

/** One Home vacation (S22): its people, actions by role, affected chores and history. */
export default async function HomeVacationPage({ params }: HomeVacationPageProps) {
  const { userId } = await requireIdentity();
  const { homeId, vacationId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <VacationDetailPage
        home={{ id: context.home.id, name: context.home.name }}
        vacationId={vacationId}
      />
    </>
  );
}
