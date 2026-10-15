# S15 · File storage and quotas — feature brief

**Branch:** `feat/file-storage`, from `main` at `66d7e5f` (S14 and its CI fix merged).
**Sources:** build plan S15 and its "Done when"; PS "Confirmed MVP personal and Home storage allowances", "Confirmed full-storage behavior", "Confirmed deleted-file storage accounting", "Confirmed deleted-file recovery period" (L791–L819); PS "Confirmed global adult avatar and display name with per-Home overrides" (L444–L451) for the first user; ARCH §10 (storage strategy B), §11 (jobs), §36 (quotas), §37 (processing), §23 (€0); CLAUDE.md file storage strategy B; ADR 0013 (avatars were initials until S15), ADR 0017 (jobs), ADR 0018 (notifications).

**Done when:** tests cover forged keys, cross-Home download, expiry, size/type mismatch and full storage.

## Gate: the storage provider (asked on 15 Oct)

Cloudflare R2 very likely asks for a card or PayPal before it can be enabled, even inside the free tier. Until Ward decides, the code is provider-neutral: one S3-compatible adapter (R2 speaks the S3 API) configured by environment variables, tested against an in-repo S3 stand-in. With no storage configured (the default everywhere hosted), file upload is switched off and avatars stay initials. Nothing is provisioned and nothing is spent.

## Actors and permissions

- **Any signed-in adult:** upload, replace and remove their own global avatar and their own per-Home avatar override (in a Home they currently belong to); see their personal storage (used, available, total, and how much is held by recently deleted files).
- **Home Owner and Administrators** (new engine action `home.storage.view`): see the Home's storage. Members do not; they only see the pool named in an over-limit error.
- **Who can see an avatar:** the person themselves; and current members of a Home in which that file is the person's effective avatar (the Home override, else the global avatar). Nobody else: not a member of another Home, not a former member, not someone holding an old link (download links live 60 seconds).
- Nobody manages another adult's avatar (spec L447), whatever their role.

## Design

1. **Database** (one migration):
   - `private.stored_files`: id, pool (`personal` with `owner_user_id`, or `home` with `owner_home_id`; a check allows exactly one), purpose (`avatar` for now), `object_key` (opaque, generated in the database from 256 random bits, prefixed by environment-free namespace `u/` or `h/`; unique; never accepted from a client), declared type and size, stored type, size and SHA-256, status (`pending` → `ready`, or `failed`; `ready` → `deleted` → `purged`), creator, request id (double-submit safety), `expires_at` for pending, `deleted_at`, `purge_after`.
   - `private.storage_pools`: one row per account and per Home with `allowance_bytes` (null = the environment default) and the warning level last notified (none / 80 / 95). Locked `for update` by every function that adds bytes, so two uploads at once cannot both fit into the last free space.
   - `private.storage_defaults`: the default personal and Home allowance. **Amounts are open in the spec** (pricing undecided), so the migration seeds clearly labelled development placeholders (1 GiB personal, 5 GiB per Home) that an operator changes with one SQL update, no deploy. A placeholder is never shown as a promise; the UI shows the number in force.
   - **Usage** of a pool = sizes of `ready` files + `deleted` files not yet purged (spec: recoverable deleted files still count) + `pending` files not yet expired (a reservation, so the check at request time holds at execution time).
   - Functions in `public` (security definer, empty `search_path`):
     - `create_upload_intent(purpose, home_id, content_type, size, request_id)` for `authenticated`: checks membership for a Home override, type and size policy per purpose, rate limits (30 intents per hour, at most 5 pending per account), locks the pool and refuses with `storage_full` when usage + size > allowance; returns file id, object key and expiry (15 minutes). Same request id returns the same intent.
     - `finalize_upload(user_id, file_id, stored_type, stored_size, sha256)` for `service_role` only, because only the server has verified the bytes: re-checks the file is the user's own and still pending and unexpired, locks the pool, re-checks capacity with the real size, marks it `ready`, then updates the warning level and notifies on crossing 80% or 95%.
     - `set_my_avatar(file_id)` and `set_my_home_avatar(home_id, file_id)` for `authenticated`: the file must be the caller's own, `ready` and an avatar; `null` clears (Home: back to inheriting). The file replaced, if no longer used anywhere by that person, becomes `deleted` with `purge_after` = now + 7 days and a delayed purge job.
     - `authorize_file_read(file_id)` for `authenticated`: returns the object key and type only when the read rule above holds; otherwise the same "not found" for every reason.
     - `my_storage_usage()` and `home_storage_usage(home_id)` (`home.storage.view` mirrored in SQL): used, reserved, deleted-but-recoverable, allowance.
   - Avatar columns: `user_preferences.avatar_file_id`, `home_member_profiles.avatar_file_id` (null = inherit), `home_directory` returns the effective avatar file id.
   - **Jobs** (outbox, ADR 0017): `storage-upload-expire` (enqueued with each intent, delayed past its expiry: if still pending, mark `failed` and delete the object, idempotent) and `storage-file-purge` (delayed to `purge_after`: if still `deleted`, delete the object, then mark `purged`, which releases the space and lowers the warning level). Both re-check state at run time and treat a missing object as done.
   - Audit: avatar set and removed per Home (ids only); no file names exist to log.
2. **Storage adapter** (`apps/web/src/storage/`, server only): presign PUT (5 minutes, signed `content-type` and `content-length`), presign GET (60 seconds, `response-content-disposition: inline` only for the processed image types, else attachment), HEAD, GET with a byte limit, PUT, DELETE. SigV4 via `aws4fetch` (MIT, small, no AWS SDK). Environment (`packages/config`, server only): `STORAGE_DRIVER` (`s3` or `off`, default `off`), `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION` (`auto` for R2), `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`. A browser never sees credentials; signed URLs are never logged.
3. **Avatar processing at finalize** (synchronous: one small image, the person is waiting): HEAD the upload, refuse if its size or type differs from what the intent declared (`mismatch`); read at most 5 MB; check the file signature (JPEG, PNG or WebP); decode with `sharp` (already in the tree through Next.js; Apache-2.0) with a pixel limit, rotate by orientation, crop to 512×512, re-encode as WebP with all metadata dropped (spec L447: no original metadata); store the result under a new key, delete the upload (the original is not kept, ARCH §37); finalize with the stored size and SHA-256. A corrupt or disguised file ends `failed` with both objects deleted.
4. **API** (`/api/v1`, same CSRF/JSON/size checks as before, verified identity, Zod, engine, then the person's own session except the service-role finalize call):
   - `POST /files/upload-intents` `{ purpose: "avatar", homeId?, contentType, size, requestId }` → `{ fileId, uploadUrl, headers, expiresAt }`
   - `POST /files/{fileId}/finalize` → `{ file }` or `mismatch`, `invalid-image`, `expired`, `storage-full`
   - `PUT /me/avatar` and `PUT /homes/{homeId}/profile/avatar` `{ fileId | null }`
   - `GET /files/{fileId}/content`: authorizes, then redirects (302) to a 60-second signed GET; `Cache-Control: private, no-store`. Images use this as their `src`, so every view is authorized again.
   - With storage off, intents answer `503 storage-unavailable`, and the pages hide the upload controls.
5. **Pages:** avatar picker on Settings → Profile (global) and Home → My profile (override, with "Use global avatar"); file type and size explained before choosing; progress, failure and retry states; preview; Remove. Avatars replace initials in the member directory, member detail and leave pages wherever an avatar is set (the account menu shows no avatar today, so none is added there). `/settings/storage` (personal) and `/homes/[homeId]/storage` (the Owner, and Administrators granted `manageHomeSettings`; others see why it is hidden): used, available, total, held by recently deleted files, and a warning banner at 80% and 95%. An over-limit error names the pool and says how to free space.
6. **Notifications:** new optional category `storage` with kinds `storage.personal_80`, `storage.personal_95`, `storage.home_80`, `storage.home_95` (Home ones to the Owner and Administrators), once per crossing; falling below resets the level.
7. **S3 stand-in** (`tools/s3-stand-in`): a small Node server that verifies SigV4 presigned query signatures, expiry and signed headers, stores objects in memory, and answers CORS for the app origin. Used by `pnpm dev` (optional) and the E2E tests; never deployed. Real R2 behaviour (CORS rules, signed content-length) is covered by the setup guide once Ward chooses.

## Tests

- **Unit:** schemas (purpose, types, size limits, request id); adapter signing against AWS's published SigV4 examples, header binding, no URL in logs; image processing (JPEG with EXIF orientation and GPS is rotated and stripped; PNG and WebP; a renamed text file, a truncated JPEG and a pixel bomb are refused); every route (CSRF, content type, unauthenticated, invalid, storage off, not a member, not found, mismatch, expired, full); usage view and warning banners with axe.
- **Database** (`tests/db/rls/storage.test.sql`): tables unreachable through the API; `finalize_upload` not executable by `authenticated`; intents only for own pool and current Homes; type and size policy; rate limits; idempotent request id; forged or another person's file id refused for finalize and avatar; expired intent cannot be finalized; full storage refused at intent and at finalize (with a pending reservation and with deleted-but-recoverable files counting); purge releases space; cross-Home read: a member of Home B cannot read a Home-A override; a former member loses read at once; the global avatar is readable only by co-members; Home pool accounting and `home_storage_usage` for the Owner and Administrators granted `manageHomeSettings` only; warning levels and notifications once per crossing. A two-connection test proves two intents racing for the last free space cannot both succeed.
- **Playwright:** upload a global avatar (stand-in storage) and see it in the directory; set a Home override, reset it; another Home's member cannot open its content URL; a file whose size differs from the declaration is refused; a full pool shows the over-limit message; storage pages with keyboard and axe in both themes.

## Out of scope (later steps)

Trash UI and restore (S16; S15 already keeps replaced avatars recoverable-and-counted for 7 days and purges them), photos and HEIC (S35), attachments (S18/S19 and later), ownership transfers that copy media (with the modules that have them), exports (S38), malware scanning (not needed for re-encoded images; revisit for arbitrary attachments), choosing real allowance amounts (pricing), child and display avatars (S41, S43).

## Defaults picked (owner may override)

- Provider-neutral until the R2 decision; storage off on previews and production until then.
- Development placeholder allowances: 1 GiB personal, 5 GiB per Home, changeable by SQL.
- Avatars: JPEG, PNG or WebP up to 5 MB, stored as a 512×512 WebP; the processed image is what counts against the personal pool.
- Per-Home avatar overrides count against the person's personal pool (they are the person's own content).
- Home storage is visible to the Owner and Administrators.
- A replaced or removed avatar stays recoverable (and counted) for 7 days, then is purged.
- Limits: 30 intents per hour, 5 pending uploads per account, upload links valid 5 minutes, pending uploads expire after 15 minutes, download links valid 60 seconds.

## Updates during the build

- Who sees a Home's storage: the Owner, and Administrators granted `manageHomeSettings` (`home.storage.view` in the permission engine), not every Administrator.
- Storage warnings are a new essential notification category `storage`, in-app only (no email), once per crossing of 80% or 95%.
- Avatar choices are not audited, consistent with profile edits (ADR 0013). Upload intents, finalize outcomes and abandoned uploads are audited by id (architecture §10, review M4).
- The web server holds the Supabase secret key for the single `finalize_upload` call (ADR 0019); awaiting the owner's explicit approval (review M3).
- R2: activating it most likely needs a payment card; the owner approved that on 2026-10-15 (decision card). The owner provisions it after merge; until then hosted environments keep `STORAGE_DRIVER=off`, and tests use the in-memory S3 stand-in.
- After the independent review (H1): finalize claims the upload first (2-minute lease, 3 attempts), images above 24 megapixels or 8192 pixels a side are refused from the header, and an unchosen finished avatar is retired by the expiry job (M2).
