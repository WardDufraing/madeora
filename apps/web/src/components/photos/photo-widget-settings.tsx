"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import {
  PHOTO_WIDGET_MAX_PHOTOS,
  photoWidgetFits,
  photoWidgetIntervals,
  photoWidgetModes,
  photoWidgetSources,
  type WidgetConfigs,
} from "@/dashboard/widgets";
import { photoContentPath, PHOTOS_ENDPOINT } from "@/photos/api";
import { PHOTO_LIMITS } from "@/photos/schema";
import { libraryPageSchema, type LibraryPage } from "@/photos/shapes";

type Config = WidgetConfigs["photos"];

async function readOptions(
  homeId: string | null,
  albumId: string | null,
  offset: number,
): Promise<LibraryPage> {
  const query = new URLSearchParams({
    scope: homeId ? "home" : "personal",
    offset: String(offset),
  });
  if (homeId) query.set("homeId", homeId);
  if (albumId) query.set("albumId", albumId);
  const response = await fetch(`${PHOTOS_ENDPOINT}?${query.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("photos read failed");
  const payload: unknown = await response.json();
  return libraryPageSchema.parse(
    payload && typeof payload === "object" && "library" in payload ? payload.library : null,
  );
}

/**
 * The photo widget's settings (S36): the source (one photo, hand-picked photos or one album of this
 * widget's context), static or slideshow, the interval and the fit, with a preview of how cover crops
 * the picture (the photo itself is never changed). Picked photos keep their order. The server checks
 * every choice again when the widget renders, for each viewer.
 */
export function PhotoWidgetSettings({
  config,
  homeId,
  onChange,
}: {
  readonly config: Config;
  /** The widget's Home, or null for the personal dashboard. */
  readonly homeId: string | null;
  readonly onChange: (config: Config) => void;
}) {
  const t = useTranslations("Photos");
  const [browseAlbum, setBrowseAlbum] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const set = <K extends keyof Config>(key: K, value: Config[K]) => {
    onChange({ ...config, [key]: value });
  };
  const listAlbum = config.source === "album" ? config.albumId : browseAlbum;
  const options = useQuery({
    queryKey: [
      "photos",
      "widget-options",
      homeId,
      listAlbum,
      config.source === "album" ? 0 : offset,
    ],
    queryFn: () => readOptions(homeId, listAlbum, config.source === "album" ? 0 : offset),
    retry: false,
  });
  const library = options.data;
  const albums = library
    ? [
        ...library.albums.map((album) => ({ id: album.id, name: album.name })),
        ...library.sharedAlbums.map((album) => ({
          id: album.id,
          name: t("widgetSharedAlbumOption", { album: album.name }),
        })),
      ]
    : [];
  const albumKnown = config.albumId === null || albums.some((album) => album.id === config.albumId);
  const picked = config.source === "photo" ? config.photoIds.slice(0, 1) : config.photoIds;
  const previewId =
    config.source === "album" ? (library?.photos[0]?.id ?? null) : (picked[0] ?? null);

  function toggle(photoId: string, on: boolean) {
    if (config.source === "photo") {
      set("photoIds", on ? [photoId] : []);
      return;
    }
    const without = config.photoIds.filter((id) => id !== photoId);
    set("photoIds", on ? [...without, photoId].slice(0, PHOTO_WIDGET_MAX_PHOTOS) : without);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="photo-widget-settings">
      {options.error ? (
        <FormAlert tone="error" announce>
          {t("widgetOptionsFailed")}
        </FormAlert>
      ) : null}
      <SelectField
        label={t("widgetSource")}
        value={config.source}
        options={photoWidgetSources.map((source) => ({
          value: source,
          label: t(`widgetSource_${source}`),
        }))}
        onChange={(event) => {
          const source = event.currentTarget.value as Config["source"];
          onChange({
            ...config,
            source,
            photoIds: source === "photo" ? config.photoIds.slice(0, 1) : config.photoIds,
          });
        }}
      />

      {config.source === "album" ? (
        <SelectField
          label={t("widgetAlbum")}
          value={config.albumId ?? ""}
          options={[
            { value: "", label: t("chooseAlbum") },
            ...(albumKnown ? [] : [{ value: config.albumId ?? "", label: t("widgetAlbumGone") }]),
            ...albums.map((album) => ({ value: album.id, label: album.name })),
          ]}
          onChange={(event) => {
            set("albumId", event.currentTarget.value === "" ? null : event.currentTarget.value);
          }}
        />
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-semibold">
            {config.source === "photo" ? t("widgetPickOne") : t("widgetPickMany")}
          </legend>
          <p className="text-helper text-fg-muted">
            {t("widgetPicked", { count: picked.length, max: PHOTO_WIDGET_MAX_PHOTOS })}
          </p>
          {albums.length > 0 ? (
            <SelectField
              label={t("widgetBrowse")}
              value={browseAlbum ?? ""}
              options={[
                { value: "", label: t("allPhotos") },
                ...albums.map((album) => ({ value: album.id, label: album.name })),
              ]}
              onChange={(event) => {
                setBrowseAlbum(event.currentTarget.value === "" ? null : event.currentTarget.value);
                setOffset(0);
              }}
            />
          ) : null}
          {library && library.photos.length === 0 ? (
            <p className="text-helper text-fg-muted">{t("widgetNothingToPick")}</p>
          ) : null}
          <ul className="grid grid-cols-3 gap-2">
            {library?.photos.map((photo, index) => (
              <li key={photo.id} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- authorized per request, redirected to a short-lived link */}
                <img
                  src={photoContentPath(photo.id, "thumb")}
                  alt=""
                  loading="lazy"
                  className="aspect-square w-full rounded-card object-cover"
                />
                <Checkbox
                  label={t("selectPhoto", { number: offset + index + 1 })}
                  checked={picked.includes(photo.id)}
                  disabled={
                    config.source === "photos" &&
                    !picked.includes(photo.id) &&
                    picked.length >= PHOTO_WIDGET_MAX_PHOTOS
                  }
                  onChange={(event) => {
                    toggle(photo.id, event.currentTarget.checked);
                  }}
                />
              </li>
            ))}
          </ul>
          {library && (offset > 0 || offset + library.photos.length < library.total) ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - PHOTO_LIMITS.page));
                }}
              >
                {t("previousPage")}
              </Button>
              <Button
                variant="secondary"
                disabled={offset + library.photos.length >= library.total}
                onClick={() => {
                  setOffset(offset + PHOTO_LIMITS.page);
                }}
              >
                {t("nextPage")}
              </Button>
            </div>
          ) : null}
          {picked.length > 0 ? (
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  set("photoIds", []);
                }}
              >
                {t("widgetClearPicked")}
              </Button>
            </div>
          ) : null}
        </fieldset>
      )}

      <SelectField
        label={t("widgetMode")}
        value={config.mode}
        options={photoWidgetModes.map((mode) => ({ value: mode, label: t(`widgetMode_${mode}`) }))}
        onChange={(event) => {
          set("mode", event.currentTarget.value as Config["mode"]);
        }}
      />
      {config.mode === "slideshow" ? (
        <SelectField
          label={t("widgetInterval")}
          value={String(config.interval)}
          options={photoWidgetIntervals.map((seconds) => ({
            value: String(seconds),
            label: t("widgetIntervalOption", { seconds }),
          }))}
          onChange={(event) => {
            set("interval", Number(event.currentTarget.value) as Config["interval"]);
          }}
        />
      ) : null}
      <SelectField
        label={t("widgetFit")}
        value={config.fit}
        options={photoWidgetFits.map((fit) => ({ value: fit, label: t(`widgetFit_${fit}`) }))}
        onChange={(event) => {
          set("fit", event.currentTarget.value as Config["fit"]);
        }}
      />
      {previewId ? (
        <figure className="flex flex-col gap-2" data-testid="photo-widget-preview">
          <div className="grid grid-cols-2 gap-2">
            {photoWidgetFits.map((fit) => (
              <div key={fit} className="flex flex-col gap-1">
                <div
                  className={`aspect-video overflow-hidden rounded-card border bg-surface-sunken ${
                    fit === config.fit ? "border-accent" : "border-line"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- authorized per request, redirected to a short-lived link */}
                  <img
                    src={photoContentPath(previewId, "display")}
                    alt=""
                    className={`h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
                  />
                </div>
                <span className="text-helper">{t(`widgetFit_${fit}`)}</span>
              </div>
            ))}
          </div>
          <figcaption className="text-helper text-fg-muted">{t("widgetFitPreview")}</figcaption>
        </figure>
      ) : null}
    </div>
  );
}
