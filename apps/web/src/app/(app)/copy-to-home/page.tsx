import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { CopyToHome } from "@/components/copies/copy-to-home";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { isCopyItemType, itemPath } from "@/copies/catalogue";
import { getCopyDestinations } from "@/copies/server";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("HomeCopies");
  return { title: await pageTitle(t("title")) };
}

interface CopyToHomePageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * "Copy to a Home" for one of the person's own personal items (S40 part 2). The item and the Homes
 * come from the database, which decides again when the copy is asked for.
 */
export default async function CopyToHomePage({ searchParams }: CopyToHomePageProps) {
  await requireIdentity();
  const [t, params] = await Promise.all([getTranslations("HomeCopies"), searchParams]);
  const type = params.type;
  const id = typeof params.id === "string" ? params.id : null;
  if (!isCopyItemType(type) || !id) {
    return <ErrorState title={t("title")} description={t("notFound")} />;
  }
  const destinations = await getCopyDestinations(type, id);
  if (destinations.status !== "ok") {
    return (
      <ErrorState
        title={t("title")}
        description={t(destinations.status === "not_found" ? "notFound" : "unavailable")}
      />
    );
  }
  const backHref = itemPath(type, id);
  const { label, files, homes } = destinations.value;

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4">
        <Link href={backHref} className="text-body font-medium text-accent-fg underline">
          {t("backToItem")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={label ?? t(`untitled.${type}`)}>
          <CopyToHome itemType={type} itemId={id} files={files} homes={homes} backHref={backHref} />
        </Card>
      </div>
    </>
  );
}
