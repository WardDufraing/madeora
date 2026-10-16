import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { TrashFiltersForm } from "@/components/trash/trash-filters";
import { TrashView } from "@/components/trash/trash-view";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { hasTrashFilters, parseTrashFilters, trashQuery } from "@/trash/filters";
import { listTrash } from "@/trash/data";
import { listTaskLists } from "@/tasks/data";

interface PersonalTrashPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Trash");
  return { title: await pageTitle(t("pageTitle")) };
}

/**
 * The signed-in person's personal trash (S16; spec "Confirmed Trash navigation placement": reached
 * from personal settings, not the sidebar). Read with their own session: nobody else's deleted
 * items, and no Home's, are ever listed here.
 */
export default async function PersonalTrashPage({ searchParams }: PersonalTrashPageProps) {
  await requireIdentity();
  const [t, formats, params] = await Promise.all([
    getTranslations("Trash"),
    getDateTimeFormats(),
    searchParams,
  ]);
  const loadedAt = new Date().toISOString();
  const filters = parseTrashFilters(params);
  const [result, lists] = await Promise.all([
    listTrash(trashQuery(filters, formats.timeZone, null)),
    listTaskLists(null, false),
  ]);

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4">
        <Link href="/settings" className="text-body font-medium text-accent-fg underline">
          {t("backToSettings")}
        </Link>
      </p>
      <p className="mb-6 max-w-2xl text-body text-fg-muted">{t("personalIntro")}</p>
      <TrashFiltersForm action="/settings/trash" filters={filters} />
      {result.status === "ok" ? (
        <TrashView
          entries={result.entries}
          homeId={null}
          homeName={null}
          formats={formats}
          filtered={hasTrashFilters(filters)}
          loadedAt={loadedAt}
          taskLists={lists.status === "ok" ? lists.value : []}
        />
      ) : (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      )}
    </>
  );
}
