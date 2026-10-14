import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { isUnbuiltSection } from "@/components/shell/nav-items";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

// Typed here rather than with Next's generated PageProps, which only exist after `next typegen`.
interface SectionPageProps {
  readonly params: Promise<{ readonly section: string }>;
}

export async function generateMetadata({ params }: SectionPageProps): Promise<Metadata> {
  const id = (await params).section;
  if (!isUnbuiltSection(id)) return {};
  const t = await getTranslations("Nav");
  return { title: await pageTitle(t(id)) };
}

/**
 * A navigation destination whose module is not built yet. Each module's step adds its own route,
 * which takes precedence over this one, and removes its id from `unbuiltSections`.
 */
export default async function UnbuiltSectionPage({ params }: SectionPageProps) {
  await requireIdentity();
  const id = (await params).section;
  if (!isUnbuiltSection(id)) notFound();

  const [tNav, t] = await Promise.all([getTranslations("Nav"), getTranslations("Placeholder")]);
  return (
    <>
      <PageHeader title={tNav(id)} />
      <EmptyState title={t("title")} description={t("description", { section: tNav(id) })} />
    </>
  );
}
