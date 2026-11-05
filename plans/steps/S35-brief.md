# S35 · Photo libraries and processing — feature brief

**Branch:** `feat/photo-libraries`, from `main` at `d192056` (S34 merged as PR #67).
**Sources (read only these):** build plan S35; Modules.md §4.7 (L114–L160: Photos module, libraries, optimized masters and derivatives, storage allowances, multi-album membership); ARCH §37 and §10; S15 brief (storage pipeline), S16 brief (trash); ADR 0045 (this step).
**Model:** Sonnet (verdict 5 Nov 2026: established patterns from S15/S16/S31, one new migration; no new auth model).
**Done when (build plan):** HEIC, orientation and corrupt-file tests pass and storage counts are correct.
**Testing rule (Ward, from S34):** locally only format, lint, typecheck and the tests this change touches (logs to files); the full suite runs on GitHub CI after the PR opens.

## Owner decision (5 Nov 2026) and defaults

Formats and limits were open in the spec, so the thread asked Ward. Until he answers the recommended default is built; changing it later is a one-line change in `private.upload_type_allowed` / `upload_max_bytes` and `apps/web/src/photos/schema.ts`:

- **Formats:** JPEG, PNG, WebP, HEIC/HEIF, GIF (first frame only). Not accepted: SVG, AVIF, RAW, video, animated playback.
- **Limits:** 25 MB per upload; at most 50 megapixels and 12 000 px on a side (refused from the header, before decoding); 100 photo ids per request; 60 photos per page; 200 albums per library; 2 000 photos per album.
- **Stored:** a WebP master (long side ≤ 2560 px) plus `full` 1920, `display` 1024 and `thumb` 320, never enlarged, never cropped; all metadata dropped; the original is deleted. All four count against the pool.

## Scope

In: personal and Home libraries; upload (batch, one at a time) with disclosure that an optimized copy is kept; processing at finalize (HEIC, orientation, GIF first frame, corrupt/mismatch/oversized refused); library page with grid, viewer, download of the optimized photo, pagination; albums (create, rename, delete to trash, add/remove, multi-album, per-library); delete photos to the trash with restore and early purge through the S16 trash UI; storage figures and the 80/95 % warnings of S15 on the page; `manageHomePhotos` capability.

Out (S36): sharing an album with other Homes, photo widget, slideshow, wall-display visibility, context-aware removal on membership change, library deletion. Out (later): account/Home deletion (S40), exports (S39), Ora.

## Permissions

| Action                                    | Personal | Home                                                                          |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| View library, photos, albums              | owner    | every current member                                                          |
| Upload, create album                      | owner    | every current member                                                          |
| Delete a photo, edit/delete/fill an album | owner    | its uploader/creator, or the Owner and Administrators with `manageHomePhotos` |
| See a photo/album trash entry             | owner    | who deleted it, or a photo manager                                            |

Anyone else, and every forged id, gets the same "not found" as for a record that does not exist.

## Design

1. **Database** (`20261121090000_photos.sql`): `private.photos`, `photo_variants` (3 derivative keys generated at intent), `photo_albums`, `photo_album_items`; no API grants. Functions: `create_photo_intent`, `get_photo_upload_keys`, `finalize_photo` (service role), `list_photo_library`, `get_photo`, `authorize_photo_read`, `delete_photos`, `create/rename/delete_photo_album`, `add_photos_to_album`, `remove_photos_from_album`; trash hooks for `photo` and `photo_album`; triggers queue derivative objects when a photo file fails, is purged or deleted.
2. **Processing** (`apps/web/src/photos/photo-image.ts`): sniff, header size check (HEIC from its `ispe` boxes), sharp or `heic-decode`, upright, four WebP outputs. HEIC decoding is WebAssembly (`libheif-js`); sharp's build has no HEVC.
3. **API:** `/api/v1/photos` (+ `/upload-intents`, `/delete`, `/:id/content`), `/api/v1/photo-albums` (+ `/:id`, `/:id/photos`); finalize reuses `/api/v1/files/:id/finalize` for purpose `photo`.
4. **Pages:** `/photos` and `/homes/[homeId]/photos` (`?album=`, `?offset=`); nav item Photos is no longer "not built"; nl and en.

## Tests

- **Database** `tests/db/rls/photos.test.sql` (passes against a throwaway PostgreSQL 16): tables and finalize unreachable for the API; intents (type, size, outsider, idempotent id, derivative keys); finalize counts four pictures in the right pool, refuses bad facts and a full pool; personal privacy; Home visibility; forged ids; delete rules, trash entry visibility, restore without double charge, purge queues all four objects; albums (tidy name, retry, stale, multi-album, remove keeps photo, cross-library add skipped, trash and restore); `manageHomePhotos`; audit holds no names. Also re-ran baseline, storage, trash, pets, recipes.
- **Unit:** processing (sniffing, HEIC, orientation, metadata stripped, GIF, mismatch, corrupt, oversized), upload helper, routes (CSRF, signed-out, invalid, outcomes, 404 as nonexistent), finalize photo path (four puts, one finalize, full pool, mismatch, idempotent), component (grid, upload off, delete confirmation, album actions, errors, axe), engine and nav tests.
- **E2E:** not added in this step (CI smoke suite unchanged); the page is covered by component tests with axe and the database tests. Flagged as a gap for the review.

## Risks and notes for Ward

- **LGPL dependency:** `libheif-js` (via `heic-decode`) is LGPL-3.0, used unmodified as a WebAssembly bundle on the server. Please confirm acceptable; the fallback is refusing HEIC.
- Synchronous processing of a large HEIC may be slow on a free Vercel function; ARCH §37 names a Trigger.dev job, which can follow if it proves too slow.
- Photo trash labels are the word "Photo" (English) because photos have no title.
- Migration: apply to `madeora-preview` before testing and to `madeora-production` before the release (docs/supabase-migrations.md, "Check S35").
