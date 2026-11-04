import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { MedicalEntryPage } from "@/components/pets/medical-entry-page";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly params: Promise<{
    readonly homeId: string;
    readonly petId: string;
    readonly entryId: string;
  }>;
}

/** A neutral title: an entry's title is medical information, never put in the tab or history. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Pets");
  return { title: await pageTitle(t("entryPageTitle")) };
}

/** One medical entry (S31), for members with medical view; not found for anyone else. */
export default async function PetMedicalEntryPage({ params }: PageProps) {
  await requireIdentity();
  const { homeId, petId, entryId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return <MedicalEntryPage homeId={context.home.id} petId={petId} entryId={entryId} />;
}
