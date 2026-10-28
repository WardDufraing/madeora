import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { AddSeveralPage } from "@/components/shopping/add-several-page";
import { pageTitle } from "@/i18n/page-title";
import { pathId } from "@/shopping/route-helpers";

interface PersonalAddSeveralProps {
  readonly params: Promise<{ readonly listId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Shopping");
  return { title: await pageTitle(t("addSeveralTitle")) };
}

/** Add several items to a Personal list (S26). */
export default async function PersonalAddSeveral({ params }: PersonalAddSeveralProps) {
  await requireIdentity();
  const listId = pathId((await params).listId);
  if (!listId) notFound();
  return <AddSeveralPage listId={listId} homeId={null} />;
}
