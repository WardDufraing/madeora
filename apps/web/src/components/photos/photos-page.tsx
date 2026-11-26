import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyOrigin, CopyToHomeLink } from "@/components/copies/copy-origin";
import { StorageUsageView } from "@/components/storage/storage-usage";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { copyPagePath } from "@/copies/catalogue";
import { listMyHomes } from "@/homes/server";
import { readLibrary } from "@/photos/data";
import { storageEnabled } from "@/storage/server";
import { getHomePhotoStorageUsage, getHomeStorageUsage, getMyStorageUsage } from "@/storage/usage";

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
  const [t, library, locale, usage, managed, myHomes] = await Promise.all([
    getTranslations("Photos"),
    readLibrary(home?.id ?? null, albumId, offset),
    getLocale(),
    // S35-L6: every member who uploads here sees the Home's storage figures; the storage page
    // itself stays with the Home's storage managers (S15), so the link shows only for them.
    home ? getHomePhotoStorageUsage(home.id) : getMyStorageUsage(),
    home ? getHomeStorageUsage(home.id) : Promise.resolve({ status: "ok" } as const),
    listMyHomes(),
  ]);
  if (library.status === "not-found") notFound();
  if (library.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const album = library.value.album;
  return (
    <>
      <PageHeader title={home ? t("homeTitle", { home: home.name }) : t("title")} />
      {/* S40 part 2: a personal album can be copied into a Home by its owner, and a Home album
          copied from personal says so. The database checks again. */}
      {album && album.owned && home === null && album.canShare ? (
        <p className="mb-4">
          <CopyToHomeLink href={copyPagePath("photo_album", album.id)} />
        </p>
      ) : null}
      {album && album.owned && home !== null ? (
        <div className="mb-4">
          <CopyOrigin type="photo_album" id={album.id} />
        </div>
      ) : null}
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
        {usage.status === "ok" && managed.status === "ok" ? (
          <Link
            href={home ? `/homes/${home.id}/storage` : "/settings/storage"}
            className="text-body link-action"
          >
            {t("storageLink")}
          </Link>
        ) : null}
      </section>
    </>
  );
}
