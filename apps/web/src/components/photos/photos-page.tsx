import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StorageUsageView } from "@/components/storage/storage-usage";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { listMyHomes } from "@/homes/server";
import { readLibrary } from "@/photos/data";
import { storageEnabled } from "@/storage/server";
import { getHomeStorageUsage, getMyStorageUsage } from "@/storage/usage";

import { PhotosView } from "./photos-view";

/**
 * The photo library page (S35): the person's personal library (`home` null) or a Home's, optionally
 * one album, read with the viewer's own session. A Home they are not in, and an album that is not in
 * this library, are not found.
 */
export async function PhotosPage({
  home,
  albumId,
  offset,
}: {
  readonly home: { readonly id: string; readonly name: string } | null;
  readonly albumId: string | null;
  readonly offset: number;
}) {
  const [t, library, locale, usage, myHomes] = await Promise.all([
    getTranslations("Photos"),
    readLibrary(home?.id ?? null, albumId, offset),
    getLocale(),
    // A Home's storage is for its storage managers (S15); anyone else gets no figures here and sees
    // the pool named if an upload does not fit.
    home ? getHomeStorageUsage(home.id) : getMyStorageUsage(),
    listMyHomes(),
  ]);
  if (library.status === "not-found") notFound();
  if (library.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  return (
    <>
      <PageHeader title={home ? t("homeTitle", { home: home.name }) : t("title")} />
      <PhotosView
        homeId={home?.id ?? null}
        library={library.value}
        offset={offset}
        uploadsEnabled={storageEnabled()}
        homes={
          myHomes.status === "ok"
            ? myHomes.homes.map((candidate) => ({ id: candidate.id, name: candidate.name }))
            : []
        }
      />
      <section aria-labelledby="photos-storage" className="mt-8 flex max-w-3xl flex-col gap-3">
        <h2 id="photos-storage" className="text-section-title font-semibold">
          {t("storageTitle")}
        </h2>
        {usage.status === "ok" ? (
          <StorageUsageView usage={usage.usage} locale={locale} pool={home ? "home" : "personal"} />
        ) : (
          <p className="text-body text-fg-muted">
            {usage.status === "unavailable" ? t("storageUnavailable") : t("storageHomeHidden")}
          </p>
        )}
        {usage.status === "ok" ? (
          <p className="text-helper text-fg-muted">{t("storageCountsHint")}</p>
        ) : null}
        {usage.status === "ok" ? (
          <Link
            href={home ? `/homes/${home.id}/storage` : "/settings/storage"}
            className="text-body font-semibold text-accent-fg underline"
          >
            {t("storageLink")}
          </Link>
        ) : null}
      </section>
    </>
  );
}
