import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { PetPage, petPageTitle } from "@/components/pets/pet-page";
import { ErrorState } from "@/components/ui/states";

interface PageProps {
  readonly params: Promise<{ readonly homeId: string; readonly petId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = await getTranslations("Pets");
  return { title: await petPageTitle((await params).petId, t("petFallbackTitle")) };
}

/** One pet of a Home (S31), for its current members; another Home's pet is not found here. */
export default async function HomePetPage({ params }: PageProps) {
  await requireIdentity();
  const { homeId, petId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return <PetPage homeId={context.home.id} petId={petId} />;
}
