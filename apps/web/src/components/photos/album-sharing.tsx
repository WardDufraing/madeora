"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { albumShareAccesses, PHOTO_LIMITS, type AlbumShareAccess } from "@/photos/schema";
import type { AlbumDetail } from "@/photos/shapes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";

interface HomeOption {
  readonly id: string;
  readonly name: string;
}

export interface AlbumSharingProps {
  readonly album: AlbumDetail;
  /** The Homes the viewer belongs to, apart from the album's own. */
  readonly homes: readonly HomeOption[];
  readonly busy: boolean;
  readonly onShare: (
    shares: readonly { readonly homeId: string; readonly access: AlbumShareAccess }[],
  ) => void;
  readonly onUnshare: (homeId: string) => void;
}

/**
 * Sharing an album with other Homes (S36), for its owner or the Home's photo managers: the current
 * audiences with their access, and adding Homes after a preview of who will see the album. Nothing
 * is copied; the database checks every share again.
 */
export function AlbumSharing({ album, homes, busy, onShare, onUnshare }: AlbumSharingProps) {
  const t = useTranslations("Photos");
  const headingId = useId();
  const [chosen, setChosen] = useState<ReadonlyMap<string, AlbumShareAccess>>(new Map());
  const [reviewing, setReviewing] = useState(false);
  const [stopping, setStopping] = useState<HomeOption | null>(null);

  const sharedIds = new Set(album.shares.map((share) => share.homeId));
  const available = homes.filter((home) => !sharedIds.has(home.id));
  const room = PHOTO_LIMITS.sharesPerAlbum - album.shares.length;
  const accessOptions = albumShareAccesses.map((access) => ({
    value: access,
    label: t(`access_${access}`),
  }));
  const chosenList = available
    .filter((home) => chosen.has(home.id))
    .map((home) => ({ home, access: chosen.get(home.id) ?? "view" }));

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      data-testid="album-sharing"
    >
      <h3 id={headingId} className="text-body font-semibold">
        {t("sharingTitle")}
      </h3>
      {album.shares.length === 0 ? (
        <p className="text-helper text-fg-muted">{t("sharingNone")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {album.shares.map((share) => (
            <li key={share.homeId} className="flex flex-wrap items-end gap-2">
              <SelectField
                label={share.homeName}
                value={share.access}
                options={accessOptions}
                disabled={busy}
                onChange={(event) => {
                  const access = event.currentTarget.value as AlbumShareAccess;
                  onShare([{ homeId: share.homeId, access }]);
                }}
              />
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setStopping({ id: share.homeId, name: share.homeName });
                }}
              >
                {t("stopSharing")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && room > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-helper text-fg-muted">{t("shareWithLegend")}</legend>
          {available.map((home) => (
            <div key={home.id} className="flex flex-wrap items-end gap-3">
              <Checkbox
                label={home.name}
                checked={chosen.has(home.id)}
                disabled={busy || (!chosen.has(home.id) && chosen.size >= room)}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  setChosen((current) => {
                    const next = new Map(current);
                    if (on) next.set(home.id, "view");
                    else next.delete(home.id);
                    return next;
                  });
                }}
              />
              {chosen.has(home.id) ? (
                <SelectField
                  label={t("shareAccessFor", { home: home.name })}
                  value={chosen.get(home.id) ?? "view"}
                  options={accessOptions}
                  onChange={(event) => {
                    const access = event.currentTarget.value as AlbumShareAccess;
                    setChosen((current) => new Map(current).set(home.id, access));
                  }}
                />
              ) : null}
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              disabled={busy || chosen.size === 0}
              onClick={() => {
                setReviewing(true);
              }}
              data-testid="album-share-review"
            >
              {t("shareReview")}
            </Button>
          </div>
        </fieldset>
      ) : available.length === 0 && album.shares.length === 0 ? (
        <p className="text-helper text-fg-muted">{t("sharingNoHomes")}</p>
      ) : null}

      <Dialog
        open={reviewing}
        onClose={() => {
          setReviewing(false);
        }}
        title={t("shareConfirmTitle", { album: album.name })}
        description={t("shareConfirmDescription")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setReviewing(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              loading={busy}
              data-testid="album-share-confirm"
              onClick={() => {
                setReviewing(false);
                onShare(chosenList.map(({ home, access }) => ({ homeId: home.id, access })));
                setChosen(new Map());
              }}
            >
              {t("shareConfirm")}
            </Button>
          </>
        }
      >
        <ul className="flex list-disc flex-col gap-1 ps-5 text-body">
          {chosenList.map(({ home, access }) => (
            <li key={home.id}>
              {t("shareAudienceLine", { home: home.name, access: t(`access_${access}`) })}
            </li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        open={stopping !== null}
        onClose={() => {
          setStopping(null);
        }}
        title={t("stopSharingTitle", { home: stopping?.name ?? "" })}
        description={t("stopSharingDescription")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setStopping(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => {
                const home = stopping;
                setStopping(null);
                if (home) onUnshare(home.id);
              }}
            >
              {t("stopSharing")}
            </Button>
          </>
        }
      />
    </section>
  );
}
