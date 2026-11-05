"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { photoContentPath, photoWidgetPath } from "@/photos/api";
import { widgetPhotosShape, type WidgetPhotos } from "@/photos/shapes";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/states";

export type PhotoWidgetSource =
  { readonly albumId: string } | { readonly photoIds: readonly string[] };

/** How often the widget asks again which photos the viewer may see, in ms. */
export const PHOTO_WIDGET_RECHECK_MS = 60_000;

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
  };
}
const pageVisible = () => document.visibilityState === "visible";

type Gone = "unavailable" | "empty" | "failed" | null;

/** At most one extra check per this many ms after pictures fail to load, in ms. */
const ERROR_RECHECK_MS = 10_000;

/**
 * The photo widget's pictures (S36): static or a slideshow with pause/play and previous/next, by
 * keyboard, pointer or touch. It advances only while the widget is on screen and the page is
 * visible, starts paused when the viewer asks for reduced motion, and changes pictures without
 * animation. Every picture is authorized again when loaded; the list is asked for again every minute
 * and whenever a picture fails, so revoked, deleted or inaccessible photos stop showing.
 */
export function PhotoSlideshow({
  homeId,
  source,
  initial,
  mode,
  interval,
  fit,
}: {
  readonly homeId: string | null;
  readonly source: PhotoWidgetSource;
  readonly initial: WidgetPhotos;
  readonly mode: "static" | "slideshow";
  /** Seconds between pictures. */
  readonly interval: number;
  readonly fit: "contain" | "cover";
}) {
  const t = useTranslations("Photos");
  const container = useRef<HTMLDivElement>(null);
  const [photos, setPhotos] = useState(initial.photos);
  const [gone, setGone] = useState<Gone>(null);
  const [currentId, setCurrentId] = useState<string | null>(initial.photos[0]?.id ?? null);
  /** null: the default (play a slideshow unless reduced motion is asked for). */
  const [chosenPlaying, setChosenPlaying] = useState<boolean | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [announce, setAnnounce] = useState(false);
  /** Pictures that failed to load since the last periodic check: not shown again until then. */
  const failed = useRef(new Set<string>());
  const lastErrorCheck = useRef(0);
  const reduced = useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => false);
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);

  const index = Math.max(
    0,
    photos.findIndex((photo) => photo.id === currentId),
  );
  const current = photos[index] ?? null;
  const multiple = photos.length > 1;
  const playing = mode === "slideshow" && multiple && (chosenPlaying ?? !reduced);
  const isAlbum = "albumId" in source;
  const sourceKey = "albumId" in source ? source.albumId : source.photoIds.join(",");

  const recheck = useCallback(async () => {
    try {
      const response = await fetch(
        photoWidgetPath(
          homeId,
          isAlbum ? { albumId: sourceKey } : { photoIds: sourceKey.split(",") },
        ),
        { cache: "no-store" },
      );
      if (response.status === 404) {
        setPhotos([]);
        setGone("unavailable");
        return;
      }
      if (!response.ok) return;
      const payload: unknown = await response.json();
      const parsed = widgetPhotosShape.safeParse(
        payload && typeof payload === "object" && "widget" in payload ? payload.widget : null,
      );
      if (!parsed.success) return;
      const shown = parsed.data.photos.filter((photo) => !failed.current.has(photo.id));
      setPhotos(shown);
      setGone(
        !parsed.data.available
          ? "unavailable"
          : parsed.data.photos.length === 0
            ? "empty"
            : shown.length === 0
              ? "failed"
              : null,
      );
    } catch {
      // Offline: keep what is shown; each picture is still authorized when it loads.
    }
  }, [homeId, isAlbum, sourceKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // Once a minute, pictures that failed get another chance.
      failed.current.clear();
      void recheck();
    }, PHOTO_WIDGET_RECHECK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [recheck]);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const go = useCallback(
    (step: number, byPerson: boolean) => {
      if (photos.length === 0) return;
      const next = photos[(index + step + photos.length) % photos.length];
      if (next) setCurrentId(next.id);
      setAnnounce(byPerson);
    },
    [index, photos],
  );

  useEffect(() => {
    if (!playing || !onScreen || !visible) return;
    const timer = window.setTimeout(() => {
      go(1, false);
    }, interval * 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [playing, onScreen, visible, interval, go, currentId]);

  if (gone === "unavailable") {
    return <EmptyState title={t("widgetUnavailableTitle")} description={t("widgetUnavailable")} />;
  }
  if (gone === "failed") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  if (gone === "empty" || !current) {
    return isAlbum ? (
      <EmptyState title={t("widgetEmptyAlbumTitle")} description={t("widgetEmptyAlbum")} />
    ) : (
      <EmptyState title={t("widgetUnavailableTitle")} description={t("widgetPhotosGone")} />
    );
  }

  const position = t("widgetPosition", { number: index + 1, total: photos.length });
  return (
    <div
      ref={container}
      className="flex h-full min-h-0 flex-col gap-2"
      data-testid="photo-widget"
      role="group"
      aria-roledescription={multiple ? t("widgetSlideshowRole") : undefined}
      aria-label={t("widgetLabel")}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-card bg-surface-sunken">
        {/* eslint-disable-next-line @next/next/no-img-element -- authorized per request, redirected to a short-lived link */}
        <img
          key={current.id}
          src={photoContentPath(current.id, "display")}
          alt={multiple ? position : t("widgetSingleAlt")}
          width={current.width}
          height={current.height}
          data-fit={fit}
          className={`absolute inset-0 h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
          onError={() => {
            // Revoked, deleted or failed: drop it now and ask which photos may still be shown, at most
            // once per ERROR_RECHECK_MS so a storage outage cannot cause a request storm.
            failed.current.add(current.id);
            setPhotos((list) => list.filter((photo) => photo.id !== current.id));
            if (photos.length <= 1) setGone("failed");
            const now = Date.now();
            if (now - lastErrorCheck.current >= ERROR_RECHECK_MS) {
              lastErrorCheck.current = now;
              void recheck();
            }
          }}
        />
      </div>
      {multiple ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              go(-1, true);
            }}
            aria-label={t("widgetPrevious")}
          >
            ‹
          </Button>
          {mode === "slideshow" ? (
            <Button
              variant="secondary"
              onClick={() => {
                setChosenPlaying(!playing);
              }}
              data-testid="photo-widget-play"
            >
              {playing ? t("widgetPause") : t("widgetPlay")}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => {
              go(1, true);
            }}
            aria-label={t("widgetNext")}
          >
            ›
          </Button>
          <span className="text-helper text-fg-muted" aria-live={announce ? "polite" : "off"}>
            {position}
          </span>
        </div>
      ) : null}
    </div>
  );
}
