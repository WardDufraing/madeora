# ADR 0019: File storage: private S3-compatible objects, database-owned quotas and one privileged finalize call

- **Status:** Accepted for S15 within the approved architecture (§10, §37), CLAUDE.md (file storage B, background processing B, database access A, configuration A, €0 budget) and the spec's storage requirements ("Confirmed progressive storage warnings", avatar rules). The owner approved Cloudflare R2 with a payment card on 2026-10-15; the owner provisions it (`docs/file-storage.md`) and storage is switched on per environment after this step is merged. The web server holding the Supabase secret key for finalize (below) awaits the owner's explicit approval. The defaults below are open to correction by the owner.
- **Date:** 2026-10-15
- **Step:** S15 (brief: `plans/steps/S15-brief.md`). Builds on S13 (outbox and jobs), S14 (notifications), S11 (member profiles) and S12 (permission engine).

## Context

Architecture §10 fixes the upload lifecycle: an authorized upload intent, a server-generated opaque key, a short-lived presigned PUT straight to a private bucket, a server-verified finalize step, and authorized short-lived GET links. The spec gives every person a personal storage pool and every Home its own, warns at 80% and 95%, and says a full pool refuses new files while everything else keeps working; recently deleted files still count until purged. The first feature that stores files is the profile picture (personal, with an optional per-Home override). No paid service may be added under the €0 rule.

## Decision

**Any S3-compatible store, behind a small adapter.** `packages/storage` signs requests itself (AWS Signature V4 with `node:crypto`; tested against AWS's published vectors), so no AWS SDK is added. It presigns PUT (binding content type and length) and GET (fixing the response type, `Content-Disposition` and `Cache-Control: private, no-store`), and does HEAD, GET with a byte limit, PUT and idempotent DELETE. Path-style URLs; R2 is configured by endpoint, bucket and a bucket-scoped key. `STORAGE_DRIVER` unset or `off` means no uploads anywhere, and the app says so. Locally and in CI, `tools/s3-stand-in` is an in-memory S3 that verifies the same signatures and CORS, so the whole flow is tested without any account.

**The database owns files, keys and quotas.** `private.stored_files` records each file (pool, purpose, creator, declared and verified type and size, SHA-256, status `pending`/`ready`/`failed`/`deleted`/`purged`). Keys are generated in the database (`u/` or `h/` plus 64 random hex digits); a browser never chooses a key or a bucket, and an object path is never a permission. `private.storage_pools` holds one pool per person and per Home with an allowance (NULL: the environment default in `private.storage_defaults`). Usage is **ready + deleted (still recoverable) + pending reservations**, computed under a row lock on the pool, so two concurrent intents can never both fit into the last space (tested with two racing connections). Every upload has its own per-person request id, so a retried request opens no second upload; a person may open 30 intents an hour and hold 5 pending.

**Two keys per upload.** The browser puts the raw bytes to `upload_key`; the processed file lives at `object_key`. The raw upload is always deleted (by the server, or by the expiry job if the server could not).

**Finalize is the one privileged call.** Before any storage work the route claims the upload (`claim_my_upload`): a 2-minute lease so the same upload is never processed twice at once, and at most 3 attempts per upload, so with the intent limits one account can cause at most a bounded number of downloads and decodes an hour. The claim is given back when the bytes are not there yet or storage cannot be reached. The finalize route reads the object back from storage, compares its real size and type with the intent, checks the file's signature, refuses from the header alone anything above 24 megapixels or 8192 pixels a side, decodes it and re-encodes a 512×512 WebP (sharp), which removes all metadata (camera, GPS, comments) and anything hidden in the file. The verified facts (type, size, checksum) must not be something a browser can claim, so `public.finalize_upload` is executable by `service_role` only, and the web server holds `SUPABASE_SERVICE_ROLE_KEY` for that single call. The function re-checks that the upload belongs to the identity the route verified, is pending and unexpired, and that the pool still has room. Nothing else in the web app uses this key; every other storage call runs with the person's own session, so RLS and the functions' own checks apply. This is the "privileged server client with explicit policy checks" that CLAUDE.md allows as an exception.

**Viewing is authorized on every request.** `GET /api/v1/files/{id}/content` asks `authorize_file_read` with the viewer's session: an avatar is visible to its owner and to people who currently share a Home where it is shown (the global avatar where no override exists, or that Home's override). It then answers `302` to a 60-second GET-only link, with `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`. Every refusal is the same 404, so file ids reveal nothing. Leaving a Home ends access on the next request; a link already issued stays valid for its 60 seconds (accepted, per architecture §10).

**Avatars.** `user_preferences.avatar_file_id` (global) and `home_member_profiles.avatar_file_id` (the person's override in one Home) point at ready avatar files of their own; set and reset go through `set_my_avatar` and `set_my_home_avatar`. Home overrides count against the **personal** pool, because they are the person's own pictures. A replaced or removed avatar is retired: status `deleted`, still counted and recoverable for 7 days, then purged by a delayed job. The directory shows pictures through the content route with a plain `<img>`; `next/image` is not used because its optimizer would cache a per-viewer authorized image for everyone.

**Warnings.** `private.storage_reassess` runs whenever usage or the allowance changes. Crossing 80% or 95% upwards sends one in-app notice (category `storage`, essential, in-app only; personal to the person, Home ones to the Home's storage managers) and records the level, so it is sent once per crossing; falling back below resets it. The storage pages compute the level from the current numbers.

**Who sees a Home's storage.** The Owner, and Administrators granted `manageHomeSettings` (`home.storage.view` in the permission engine, `private.can_view_home_storage` in SQL). Nobody but the person sees their personal pool.

**Audit.** Opening an upload, each finalize outcome (ready or refused) and abandoning a mismatched upload write `private.audit_events` rows by id only (subject `stored_file`), as architecture §10 asks for signing and finalization. Choosing or removing an avatar is not audited, consistent with profile edits (ADR 0013).

**Clean-up through the S13 outbox.** `storage-upload-expire` (an unfinished upload becomes `failed`, its objects are queued for removal; a finished avatar that was never chosen is retired, so it cannot count forever unseen), `storage-file-purge` (after the recovery period) and `storage-object-delete` (one object per queue row, idempotent, retried while storage is unreachable). A trigger queues objects when a file row disappears, so no path leaks objects.

## Defaults chosen (owner may correct)

1. Allowances 1 GiB personal and 5 GiB per Home, as development placeholders: the spec leaves the sizes to the plan design. The owner changes them per environment or per pool with SQL (`docs/file-storage.md`).
2. Avatars: JPEG, PNG or WebP, up to 5 MB, stored as a 512×512 WebP; the original is not kept.
3. Deleted files are recoverable and keep counting for 7 days.
4. Links: 5-minute upload links, 15-minute intents, 60-second view links.
5. Avatar choices are not audited (ADR 0013); uploads are. A finished upload never chosen is retired by the expiry job about 20 minutes after it was opened.
6. Finalize: a 2-minute lease and 3 attempts per upload; images up to 24 megapixels and 8192 pixels a side.

## Consequences

- Until the owner has provisioned R2 and set the variables for an environment, it runs with storage off: nobody can upload a picture there, and the app says so. Initials stay as they are.
- The web server now holds a Supabase secret key where storage is on. It is server-only, validated at startup (the app refuses to start with storage on and no key), used for one function, and never given to PR previews unless the owner chooses to. This needs the owner's explicit approval (CLAUDE.md: privileged server clients are exceptional); the alternative is a narrower, HMAC-signed finalize check inside the database, which adds a secret to manage in Postgres.
- There is no restore-from-deleted screen yet: the spec's recovery UI comes with the first feature where people delete files themselves. The data model already supports it.
- Uploads of other kinds (documents, photos, Home files) reuse the same pipeline; each new purpose adds its own type and size policy and processing step.
