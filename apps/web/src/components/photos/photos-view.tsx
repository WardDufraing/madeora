"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type SyntheticEvent } from "react";

import { photoContentPath, photosPath } from "@/photos/api";
import {
  addToAlbum,
  createAlbum,
  deleteAlbum,
  deletePhotos,
  PhotoRequestError,
  removeFromAlbum,
  renameAlbum,
  shareAlbum,
  unshareAlbum,
} from "@/photos/request";
import { PHOTO_LIMITS, photoUploadTypes } from "@/photos/schema";
import type { AlbumTarget, LibraryPage, Photo } from "@/photos/shapes";
import { checkPhotoFile, PhotoUploadError, uploadPhoto } from "@/photos/upload";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { EmptyState } from "@/components/ui/states";
import { TextField } from "@/components/ui/text-field";

import { AlbumSharing } from "./album-sharing";
import { LibraryDeleteDialog } from "./library-delete-dialog";

export interface PhotosViewProps {
  /** The Home whose library this is; null for the person's personal library. */
  readonly homeId: string | null;
  readonly library: LibraryPage;
  readonly offset: number;
  /** Whether uploads are possible here (storage is configured). */
  readonly uploadsEnabled: boolean;
  /** The Homes the viewer belongs to, as sharing destinations (S36). */
  readonly homes: readonly { readonly id: string; readonly name: string }[];
}

function nameOf(data: FormData): string {
  const value = data.get("name");
  return typeof value === "string" ? value.trim() : "";
}

interface UploadRow {
  readonly key: string;
  readonly name: string;
  readonly state: "working" | "done" | { readonly failed: string };
}

/**
 * A photo library (S35): the grid of photos, upload with progress and per-file failures, albums
 * (a photo may be in many; taking it out of an album never deletes it), and moving photos to the
 * trash. S36 adds albums shared with other Homes (sharing, contributions, "Remove from this Home"),
 * and keeps "Remove from this album" apart from "Delete from library", which previews its impact
 * first. Everything here only offers; the database decides every action again.
 */
export function PhotosView({ homeId, library, offset, uploadsEnabled, homes }: PhotosViewProps) {
  const t = useTranslations("Photos");
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [uploads, setUploads] = useState<readonly UploadRow[]>([]);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [deleting, setDeleting] = useState<readonly string[] | null>(null);
  const [confirmingTarget, setConfirmingTarget] = useState<AlbumTarget | null>(null);
  const [confirmingUnshare, setConfirmingUnshare] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingAlbumDelete, setConfirmingAlbumDelete] = useState(false);
  const [viewing, setViewing] = useState<Photo | null>(null);
  const [targetAlbum, setTargetAlbum] = useState("");
  const [busy, setBusy] = useState(false);

  const owner = homeId ? ({ scope: "home", homeId } as const) : ({ scope: "personal" } as const);
  const album = library.album;
  const canEditAlbum = album?.access === "edit" && album.owned;
  const selectedIds = [...selected];
  const selectedPhotos = library.photos.filter((photo) => selected.has(photo.id));
  const removable = selectedPhotos.filter((photo) => photo.canRemove === true).map((p) => p.id);
  const deletable = selectedPhotos.filter((photo) => photo.canDelete).map((photo) => photo.id);

  function refresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  function requestError(failure: unknown): string {
    if (failure instanceof PhotoRequestError) {
      switch (failure.failure) {
        case "signedOut":
          return t("errorSignedOut");
        case "notPermitted":
          return t("errorNotPermitted");
        case "notFound":
          return t("errorNotFound");
        case "conflict":
          return t("errorConflict");
        case "limit":
          return t("errorLimit");
        case "invalid":
          return t("errorInvalid");
        case "network":
          return t("errorNetwork");
      }
    }
    return t("errorFailed");
  }

  function uploadError(failure: unknown): string {
    if (failure instanceof PhotoUploadError) {
      switch (failure.failure) {
        case "type":
          return t("uploadErrorType");
        case "size":
          return t("uploadErrorSize", { max: PHOTO_LIMITS.uploadBytes / (1024 * 1024) });
        case "storageFull":
          return t("uploadErrorStorageFull");
        case "storageOff":
          return t("uploadErrorStorageOff");
        case "rateLimited":
          return t("uploadErrorRateLimited");
        case "invalidFile":
          return t("uploadErrorInvalidFile");
        case "expired":
          return t("uploadErrorExpired");
        case "notPermitted":
          return t("errorNotPermitted");
        case "signedOut":
          return t("errorSignedOut");
        case "network":
          return t("errorNetwork");
      }
    }
    return t("errorFailed");
  }

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await action());
      setSelected(new Set());
      refresh();
    } catch (failure) {
      setError(requestError(failure));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError("");
    setMessage("");
    const chosen = [...files];
    const rows: UploadRow[] = chosen.map((file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      state: "working",
    }));
    setUploads(rows);
    let stored = 0;
    // One at a time: each is decoded and re-encoded on the server, and the pool is locked per file.
    for (const [index, file] of chosen.entries()) {
      const row = rows[index];
      if (!row) continue;
      const checked = checkPhotoFile(file);
      let state: UploadRow["state"];
      if ("problem" in checked) {
        state = {
          failed: t(checked.problem === "type" ? "uploadErrorType" : "uploadErrorSize", {
            max: PHOTO_LIMITS.uploadBytes / (1024 * 1024),
          }),
        };
      } else {
        try {
          await uploadPhoto(file, owner, row.key);
          state = "done";
          stored += 1;
        } catch (failure) {
          state = { failed: uploadError(failure) };
        }
      }
      rows[index] = { ...row, state };
      setUploads([...rows]);
    }
    if (fileInput.current) fileInput.current.value = "";
    setMessage(t("uploadSummary", { stored, total: chosen.length }));
    refresh();
  }

  function toggle(photoId: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(photoId);
      else next.delete(photoId);
      return next;
    });
  }

  function onCreateAlbum(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = nameOf(new FormData(form));
    if (!name) return;
    void run(async () => {
      await createAlbum(crypto.randomUUID(), owner, name);
      form.reset();
      return t("albumCreated");
    });
  }

  function onRenameAlbum(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!album) return;
    const name = nameOf(new FormData(event.currentTarget));
    if (!name) return;
    void run(async () => {
      await renameAlbum(album.id, name, album.revision);
      return t("albumRenamed");
    });
  }

  const pageSize = PHOTO_LIMITS.page;
  const hasPrevious = offset > 0;
  const hasNext = offset + library.photos.length < library.total;
  const accept = [...photoUploadTypes, ".heic", ".heif"].join(",");
  const targets = library.targets.filter((candidate) => candidate.id !== library.albumId);
  const chosenTarget = targets.find((candidate) => candidate.id === targetAlbum) ?? null;

  function removeSelected() {
    if (!album) return;
    const albumId = album.id;
    void run(async () => {
      await removeFromAlbum(albumId, removable);
      return t("removedFromAlbum");
    });
  }

  function addToTarget(target: AlbumTarget) {
    void run(async () => {
      await addToAlbum(target.id, selectedIds);
      return t("addedToAlbum");
    });
  }

  return (
    <div className="flex flex-col gap-6" data-testid="photos-view">
      <nav aria-label={t("albumsNav")} className="flex flex-wrap gap-2">
        <Link
          href={photosPath(homeId)}
          aria-current={library.albumId === null ? "page" : undefined}
          className="rounded-control border border-line-control px-3 py-1.5 text-helper aria-[current=page]:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t("allPhotos")}
        </Link>
        {library.albums.map((candidate) => (
          <Link
            key={candidate.id}
            href={photosPath(homeId, { albumId: candidate.id })}
            aria-current={library.albumId === candidate.id ? "page" : undefined}
            data-testid="album-link"
            className="rounded-control border border-line-control px-3 py-1.5 text-helper aria-[current=page]:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <bdi>{candidate.name}</bdi>{" "}
            <span className="text-fg-muted">({candidate.photoCount})</span>
            {candidate.shareCount > 0 ? (
              <span className="text-fg-muted"> · {t("sharedBadge")}</span>
            ) : null}
          </Link>
        ))}
        {library.sharedAlbums.map((candidate) => (
          <Link
            key={candidate.id}
            href={photosPath(homeId, { albumId: candidate.id })}
            aria-current={library.albumId === candidate.id ? "page" : undefined}
            data-testid="shared-album-link"
            className="rounded-control border border-dashed border-line-control px-3 py-1.5 text-helper aria-[current=page]:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <bdi>{candidate.name}</bdi>{" "}
            <span className="text-fg-muted">({candidate.photoCount})</span>
            <span className="text-fg-muted">
              {" "}
              ·{" "}
              {candidate.ownerHomeName
                ? t("sharedFromHome", { home: candidate.ownerHomeName })
                : t("sharedFromPerson")}
            </span>
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap items-end gap-4">
        {library.canUpload ? (
          uploadsEnabled ? (
            <div className="flex flex-col gap-1">
              <label className="inline-flex min-h-10 cursor-pointer items-center rounded-control bg-accent px-4 text-body text-on-accent hover:bg-accent-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
                {t("upload")}
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={accept}
                  className="sr-only"
                  data-testid="photo-file-input"
                  onChange={(event) => {
                    void onFiles(event.currentTarget.files);
                  }}
                />
              </label>
              <p className="text-helper text-fg-muted">
                {t("uploadHelp", { max: PHOTO_LIMITS.uploadBytes / (1024 * 1024) })}
              </p>
            </div>
          ) : (
            <p className="text-helper text-fg-muted">{t("uploadsOff")}</p>
          )
        ) : null}
        <form onSubmit={onCreateAlbum} className="flex items-end gap-2">
          <TextField
            name="name"
            label={t("newAlbumName")}
            maxLength={PHOTO_LIMITS.albumName}
            required
          />
          <Button type="submit" variant="secondary" disabled={busy} data-testid="album-create">
            {t("createAlbum")}
          </Button>
        </form>
      </div>

      <div id={statusId} role="status" aria-live="polite" className="text-body">
        {message}
      </div>
      {error ? (
        <p role="alert" className="text-body text-danger" data-testid="photos-error">
          {error}
        </p>
      ) : null}
      {uploads.length > 0 ? (
        <ul className="flex flex-col gap-1 text-helper" data-testid="upload-list">
          {uploads.map((row) => (
            <li key={row.key}>
              <bdi>{row.name}</bdi>:{" "}
              {row.state === "working"
                ? t("uploadWorking")
                : row.state === "done"
                  ? t("uploadDone")
                  : row.state.failed}
            </li>
          ))}
        </ul>
      ) : null}

      {album ? (
        <section aria-labelledby={`${statusId}-album`} className="flex flex-col gap-3">
          <h2 id={`${statusId}-album`} className="text-section-title font-semibold">
            <bdi>{album.name}</bdi>
          </h2>
          {!album.owned ? (
            <p className="text-helper text-fg-muted" data-testid="shared-album-note">
              {album.ownerHomeName
                ? t("sharedAlbumNoteHome", { home: album.ownerHomeName })
                : t("sharedAlbumNotePerson")}{" "}
              {t(album.canContribute ? "sharedAlbumCanAdd" : "sharedAlbumViewOnly")}
            </p>
          ) : album.shareCount > 0 && !album.canShare ? (
            <p className="text-helper text-fg-muted">
              {t("sharedWithCount", { count: album.shareCount })}
            </p>
          ) : null}
          {album.canRemoveShare && homeId ? (
            <div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirmingUnshare(true);
                }}
                data-testid="album-remove-from-home"
              >
                {t("removeFromHome")}
              </Button>
            </div>
          ) : null}
          {canEditAlbum ? (
            <div className="flex flex-wrap items-end gap-2">
              <form onSubmit={onRenameAlbum} className="flex items-end gap-2" key={album.revision}>
                <TextField
                  name="name"
                  label={t("renameAlbum")}
                  defaultValue={album.name}
                  maxLength={PHOTO_LIMITS.albumName}
                  required
                />
                <Button type="submit" variant="secondary" disabled={busy}>
                  {t("save")}
                </Button>
              </form>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setConfirmingAlbumDelete(true);
                }}
              >
                {t("deleteAlbum")}
              </Button>
            </div>
          ) : null}
          {album.canShare && album.owned ? (
            <AlbumSharing
              album={album}
              homes={homes.filter((home) => home.id !== homeId)}
              busy={busy}
              onShare={(shares) => {
                void run(async () => {
                  await shareAlbum(album.id, shares);
                  return t("sharingSaved");
                });
              }}
              onUnshare={(home) => {
                void run(async () => {
                  await unshareAlbum(album.id, home);
                  return t("sharingStopped");
                });
              }}
            />
          ) : null}
        </section>
      ) : null}

      {selectedIds.length > 0 ? (
        <div
          className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-surface p-3"
          role="group"
          aria-label={t("selectionActions")}
        >
          <p className="text-body font-semibold">{t("selected", { count: selectedIds.length })}</p>
          {targets.length > 0 ? (
            <>
              <SelectField
                label={t("addToAlbumLabel")}
                value={targetAlbum}
                onChange={(event) => {
                  setTargetAlbum(event.currentTarget.value);
                }}
                options={[
                  { value: "", label: t("chooseAlbum") },
                  ...targets.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.shared
                      ? t("targetShared", {
                          album: candidate.name,
                          owner: candidate.ownerHomeName ?? t("targetPersonal"),
                        })
                      : candidate.name,
                  })),
                ]}
              />
              <Button
                variant="secondary"
                disabled={busy || chosenTarget === null}
                onClick={() => {
                  if (!chosenTarget) return;
                  if (chosenTarget.shared) setConfirmingTarget(chosenTarget);
                  else addToTarget(chosenTarget);
                }}
              >
                {t("addToAlbum")}
              </Button>
            </>
          ) : null}
          {album && removable.length > 0 ? (
            <Button
              variant="secondary"
              disabled={busy}
              data-testid="photos-remove-from-album"
              onClick={() => {
                // In an album others see through a share, say first who loses these photos.
                if (!album.owned || album.shareCount > 0) setConfirmingRemove(true);
                else removeSelected();
              }}
            >
              {t("removeFromAlbum")}
            </Button>
          ) : null}
          {deletable.length > 0 ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setDeleting(deletable);
              }}
              data-testid="photos-delete"
            >
              {t("deleteFromLibrary")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {library.photos.length === 0 ? (
        <EmptyState
          title={album ? t("emptyAlbumTitle") : t("emptyTitle")}
          description={album ? t("emptyAlbum") : library.canUpload ? t("empty") : t("emptyView")}
        />
      ) : (
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          aria-busy={refreshing || busy}
          data-testid="photo-grid"
        >
          {library.photos.map((photo, index) => (
            <li key={photo.id} className="flex flex-col gap-1" data-testid="photo-item">
              <button
                type="button"
                onClick={() => {
                  setViewing(photo);
                }}
                className="overflow-hidden rounded-card border border-line bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                aria-label={t("openPhoto", { number: offset + index + 1 })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- authorized per request, redirected to a short-lived link */}
                <img
                  src={photoContentPath(photo.id, "thumb")}
                  alt=""
                  loading="lazy"
                  width={320}
                  height={Math.max(1, Math.round((320 * photo.height) / photo.width))}
                  className="aspect-square w-full object-cover"
                />
              </button>
              <Checkbox
                label={t("selectPhoto", { number: offset + index + 1 })}
                checked={selected.has(photo.id)}
                onChange={(event) => {
                  toggle(photo.id, event.currentTarget.checked);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {hasPrevious || hasNext ? (
        <nav aria-label={t("pages")} className="flex items-center gap-4 text-body">
          {hasPrevious ? (
            <Link
              href={photosPath(homeId, {
                albumId: library.albumId,
                offset: Math.max(0, offset - pageSize),
              })}
              className="underline"
            >
              {t("previousPage")}
            </Link>
          ) : null}
          <span className="text-fg-muted">
            {t("range", {
              from: offset + 1,
              to: offset + library.photos.length,
              total: library.total,
            })}
          </span>
          {hasNext ? (
            <Link
              href={photosPath(homeId, { albumId: library.albumId, offset: offset + pageSize })}
              className="underline"
            >
              {t("nextPage")}
            </Link>
          ) : null}
        </nav>
      ) : null}

      <Dialog
        open={viewing !== null}
        onClose={() => {
          setViewing(null);
        }}
        title={t("viewerTitle")}
        closeLabel={t("close")}
        footer={
          viewing ? (
            <a
              className="underline"
              href={`${photoContentPath(viewing.id, "master")}&download=1`}
              download
            >
              {t("download")}
            </a>
          ) : null
        }
      >
        {viewing ? (
          // eslint-disable-next-line @next/next/no-img-element -- authorized per request, redirected to a short-lived link
          <img
            src={photoContentPath(viewing.id, "full")}
            alt={t("viewerAlt")}
            className="max-h-[70vh] w-full object-contain"
          />
        ) : null}
      </Dialog>

      <LibraryDeleteDialog
        photoIds={deleting}
        busy={busy}
        onClose={() => {
          setDeleting(null);
        }}
        onConfirm={(photoIds) => {
          setDeleting(null);
          void run(async () => {
            const result = await deletePhotos(photoIds);
            return result.skipped > 0
              ? t("deletedSome", { deleted: result.deleted, skipped: result.skipped })
              : t("deleted", { count: result.deleted });
          });
        }}
      />

      <Dialog
        open={confirmingTarget !== null}
        onClose={() => {
          setConfirmingTarget(null);
        }}
        title={t("addSharedTitle", { album: confirmingTarget?.name ?? "" })}
        description={t("addSharedDescription")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingTarget(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              loading={busy}
              data-testid="add-shared-confirm"
              onClick={() => {
                const target = confirmingTarget;
                setConfirmingTarget(null);
                if (target) addToTarget(target);
              }}
            >
              {t("addToAlbum")}
            </Button>
          </>
        }
      />

      <Dialog
        open={confirmingRemove}
        onClose={() => {
          setConfirmingRemove(false);
        }}
        title={t("removeSharedTitle", { count: removable.length })}
        description={t("removeSharedDescription")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingRemove(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              loading={busy}
              data-testid="remove-shared-confirm"
              onClick={() => {
                setConfirmingRemove(false);
                removeSelected();
              }}
            >
              {t("removeFromAlbum")}
            </Button>
          </>
        }
      />

      <Dialog
        open={confirmingUnshare}
        onClose={() => {
          setConfirmingUnshare(false);
        }}
        title={t("removeFromHomeTitle")}
        description={t("removeFromHomeDescription")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingUnshare(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              data-testid="album-remove-from-home-confirm"
              onClick={() => {
                setConfirmingUnshare(false);
                if (!album || !homeId) return;
                void run(async () => {
                  await unshareAlbum(album.id, homeId);
                  router.push(photosPath(homeId));
                  return t("removedFromHome");
                });
              }}
            >
              {t("removeFromHome")}
            </Button>
          </>
        }
      />

      <Dialog
        open={confirmingAlbumDelete}
        onClose={() => {
          setConfirmingAlbumDelete(false);
        }}
        title={t("deleteAlbumTitle")}
        description={t("deleteAlbumDescription")}
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingAlbumDelete(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => {
                setConfirmingAlbumDelete(false);
                if (!album) return;
                void run(async () => {
                  await deleteAlbum(album.id, album.revision);
                  router.push(photosPath(homeId));
                  return t("albumDeleted");
                });
              }}
            >
              {t("deleteAlbum")}
            </Button>
          </>
        }
      />
    </div>
  );
}
