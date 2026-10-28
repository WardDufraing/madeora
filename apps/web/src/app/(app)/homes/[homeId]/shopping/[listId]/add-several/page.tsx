import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { AddSeveralPage } from "@/components/shopping/add-several-page";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { pathId } from "@/shopping/route-helpers";

interface HomeAddSeveralProps {
  readonly params: Promise<{ readonly homeId: string; readonly listId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Shopping");
  return { title: await pageTitle(t("addSeveralTitle")) };
}

/** Add several items to a Home's list (S26). */
export default async function HomeAddSeveral({ params }: HomeAddSeveralProps) {
  await requireIdentity();
  const { homeId, listId } = await params;
  const id = pathId(listId);
  if (!id) notFound();
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return <AddSeveralPage listId={id} homeId={context.home.id} />;
}
