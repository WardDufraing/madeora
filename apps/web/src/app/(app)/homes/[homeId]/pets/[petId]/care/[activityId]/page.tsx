import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { CareActivityPage } from "@/components/pets/care-activity-page";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly params: Promise<{
    readonly homeId: string;
    readonly petId: string;
    readonly activityId: string;
  }>;
}

/** A neutral title: a care title can be medical information, never put in the tab or history. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Pets");
  return { title: await pageTitle(t("carePageTitle")) };
}

/** One care activity of a pet (S31), for the Home's current members. */
export default async function PetCareActivityPage({ params }: PageProps) {
  await requireIdentity();
  const { homeId, petId, activityId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return <CareActivityPage homeId={context.home.id} petId={petId} activityId={activityId} />;
}
