import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { TrashFiltersForm } from "@/components/trash/trash-filters";
import { TrashView } from "@/components/trash/trash-view";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { listTaskLists } from "@/tasks/data";
import { listTrash } from "@/trash/data";
import { hasTrashFilters, parseTrashFilters, trashQuery } from "@/trash/filters";

interface HomeTrashPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: HomeTrashPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Trash"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("homePageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * A Home's trash (S16; spec "Confirmed Trash navigation placement": reached from that Home's
 * settings). Every member of the Home may open it; the database shows each person only what they
 * may see: their own deletions, and everything to the Owner and the Administrators granted
 * manageHomeSettings. The permission check here only decides what to render.
 */
export default async function HomeTrashPage({ params, searchParams }: HomeTrashPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes, formats, query] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Trash"),
    getTranslations("Homes"),
    getDateTimeFormats(),
    searchParams,
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, permissions } = context;
  const loadedAt = new Date().toISOString();
  const filters = parseTrashFilters(query);
  const [result, lists] = await Promise.all([
    permissions["home.trash.view"]
      ? listTrash(trashQuery(filters, formats.timeZone, home.id))
      : Promise.resolve({ status: "not-found" } as const),
    listTaskLists(home.id, false),
  ]);
  const path = `/homes/${home.id}/trash`;

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}/settings`} className="font-medium text-accent-fg underline">
          {tHomes("settingsTitle")}
        </Link>
      </p>
      {result.status === "not-found" ? (
        <EmptyState title={t("notAvailableTitle")} description={t("notAvailable")} />
      ) : result.status === "unavailable" ? (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      ) : (
        <>
          <p className="mb-6 max-w-2xl text-body text-fg-muted">
            {permissions["home.trash.viewAll"] ? t("homeIntroManager") : t("homeIntroMember")}
          </p>
          <TrashFiltersForm action={path} filters={filters} />
          <TrashView
            entries={result.entries}
            homeId={home.id}
            homeName={home.name}
            formats={formats}
            filtered={hasTrashFilters(filters)}
            loadedAt={loadedAt}
            taskLists={lists.status === "ok" ? lists.value : []}
          />
        </>
      )}
    </>
  );
}
