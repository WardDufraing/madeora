"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { readDeletionImpact } from "@/photos/request";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * "Delete from library" (S36): before photos leave their library, shows what it affects (the
 * library, the albums and Homes the viewer can see that lose them, a flag for those they cannot see,
 * and widgets), then asks for confirmation. Cancel changes nothing; the database decides again.
 */
export function LibraryDeleteDialog({
  photoIds,
  busy,
  onClose,
  onConfirm,
}: {
  /** The photos to delete; null while closed. */
  readonly photoIds: readonly string[] | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (photoIds: readonly string[]) => void;
}) {
  const t = useTranslations("Photos");
  const key = photoIds?.join(",") ?? "";
  // Asked again each time the dialog opens: the impact is read when the person decides, never cached.
  const query = useQuery({
    queryKey: ["photos", "deletion-impact", key],
    queryFn: () => readDeletionImpact(key.split(",")),
    enabled: key !== "",
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const impact = query.data ?? null;
  const libraries = impact
    ? impact.libraries.map((library) =>
        library.personal
          ? t("impactLibraryPersonal")
          : t("impactLibraryHome", { home: library.homeName ?? "" }),
      )
    : [];

  return (
    <Dialog
      open={photoIds !== null}
      onClose={onClose}
      title={t("libraryDeleteTitle", { count: impact?.deletable ?? photoIds?.length ?? 0 })}
      description={t("libraryDeleteDescription")}
      closeLabel={t("close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={!impact || impact.deletable === 0}
            data-testid="photos-delete-confirm"
            onClick={() => {
              if (photoIds) onConfirm(photoIds);
            }}
          >
            {t("deleteFromLibrary")}
          </Button>
        </>
      }
    >
      <div aria-live="polite" className="flex flex-col gap-2 text-body" data-testid="delete-impact">
        {query.isPending ? <p>{t("impactLoading")}</p> : null}
        {query.isError ? <p role="alert">{t("impactFailed")}</p> : null}
        {impact ? (
          <>
            {impact.deletable === 0 ? <p>{t("impactNone")}</p> : null}
            {impact.skipped > 0 && impact.deletable > 0 ? (
              <p>{t("impactSkipped", { count: impact.skipped })}</p>
            ) : null}
            {libraries.length > 0 ? (
              <p>{t("impactLibraries", { libraries: libraries.join(", ") })}</p>
            ) : null}
            {impact.albums.length > 0 ? (
              <p>{t("impactAlbums", { albums: impact.albums.join(", ") })}</p>
            ) : null}
            {impact.otherAlbums ? <p>{t("impactOtherAlbums")}</p> : null}
            {impact.sharedHomes.length > 0 ? (
              <p>{t("impactHomes", { homes: impact.sharedHomes.join(", ") })}</p>
            ) : null}
            {impact.otherHomes ? <p>{t("impactOtherHomes")}</p> : null}
            {impact.deletable > 0 ? <p>{t("impactWidgets")}</p> : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
