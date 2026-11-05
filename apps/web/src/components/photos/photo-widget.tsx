import { getTranslations } from "next-intl/server";

import { EmptyState, ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { readWidgetPhotos } from "@/photos/data";

import { PhotoSlideshow, type PhotoWidgetSource } from "./photo-slideshow";

/** The source a widget's settings name, or null when none is chosen yet. */
export function widgetSource(config: WidgetConfigs["photos"]): PhotoWidgetSource | null {
  if (config.source === "album") return config.albumId ? { albumId: config.albumId } : null;
  const photoIds = config.source === "photo" ? config.photoIds.slice(0, 1) : config.photoIds;
  return photoIds.length > 0 ? { photoIds } : null;
}

/**
 * The photo widget (S36), read on the server with the viewer's own session: only the photos they may
 * see now in this widget's context (`homeId` null: the personal dashboard). An album that cannot be
 * used here, picked photos that are gone and an empty album each show their own state; nothing else
 * is ever shown instead, and no count, name or thumbnail of what is hidden.
 */
export async function PhotoWidget({
  homeId,
  config,
}: {
  readonly homeId: string | null;
  readonly config: WidgetConfigs["photos"];
}) {
  const t = await getTranslations("Photos");
  const source = widgetSource(config);
  if (!source) {
    return <EmptyState title={t("widgetNoSourceTitle")} description={t("widgetNoSource")} />;
  }
  const read = await readWidgetPhotos(homeId, source);
  if (read.status === "not-found" || (read.status === "ok" && !read.value.available)) {
    return <EmptyState title={t("widgetUnavailableTitle")} description={t("widgetUnavailable")} />;
  }
  if (read.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  if (read.value.photos.length === 0) {
    return "albumId" in source ? (
      <EmptyState title={t("widgetEmptyAlbumTitle")} description={t("widgetEmptyAlbum")} />
    ) : (
      <EmptyState title={t("widgetUnavailableTitle")} description={t("widgetPhotosGone")} />
    );
  }
  return (
    <PhotoSlideshow
      homeId={homeId}
      source={source}
      initial={read.value}
      mode={config.mode}
      interval={config.interval}
      fit={config.fit}
    />
  );
}
