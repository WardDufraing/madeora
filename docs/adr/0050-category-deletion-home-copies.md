# ADR 0050: Category deletion of personal data and copies of personal items into a Home

- **Status:** Proposed for S40 (part 2) within the approved architecture (§7 identity, §11 background jobs, file storage strategy B), CLAUDE.md (authorization C, database access A, background processing B, €0 budget), ADR 0047 (reauthentication), ADR 0048 (exports) and ADR 0049 (account and Home deletion). The values listed under "Open values" wait for the owner's approval.
- **Date:** 2026-11-11
- **Step:** S40 part 2 (brief: `plans/steps/S40-brief.md`, "Part 2").

## Context

The spec asks for confirmed deletion of chosen categories of an adult's personal data, and for a way to move personal content into a Home before it is deleted: an independent Home-owned copy of a personal item, made directly or after approval in that Home, with a quiet origin label, a 30-day expiry for waiting requests, and account deletion that lists pending transfers and asks the person to cancel them.

## Decision

**Category deletion is one database call.** `public.delete_personal_data(request_id, categories)` needs a fresh `authorize_account_change('delete_personal_data')` (a new S37 action), takes a per-account advisory lock, and deletes each chosen category in its own sub-transaction, so one failing category is reported while the others stand (`completed`, `partial` or `failed`). The request and its per-category result are stored in `private.personal_data_deletions`, keyed by account and request id: a repeated request returns the stored result instead of running again. Deleted files go through the existing `stored_files` deletion path, so their objects are queued for removal; shares of deleted items end with them; S39 triggers invalidate personal exports that are being prepared or ready; pending copy requests of deleted items end. Nothing Home-owned is touched. `public.personal_deletion_preview()` gives the per-category counts the page shows before the person confirms. The typed confirmation word is checked by the HTTP route, as for account deletion.

**A copy is a new Home item, never a moved one.** `request_home_copies(item, homes)` evaluates every Home on its own: the person must be a current member and own the eligible personal item. When they may create that content in the Home now (recipes: `manageHomeRecipes`; calendar: level `edit`; photos: album access) the copy is made right away; otherwise a pending request waits for an approver (the Owner, every Administrator, or anyone with that creation right). An approver may approve their own request; it is recorded as such. Every approval and completion checks the requester, the item, the request and the authority behind the copy again (the requester's creation right for a direct copy, the approver's right otherwise), and ends the request `invalidated` when one no longer holds. The original stays the person's; if it was shared with that Home, that share ends. The copy records `copied_from_personal_at` and nothing else about its origin.

**Files are copied inside the bucket by a job.** An item without files is copied in the same transaction. For a recipe cover or album photos, `start_home_copy` reserves the destination Home's storage (refused with `storage_full`), creates the new Home `stored_files` rows with server-generated keys, and enqueues `home-copy-files` through the outbox. The job copies each object with S3 `CopyObject` (the bytes never pass through the job), checks the copy's size with HEAD, and calls `finish_home_copy_files`; the database then creates the Home item, marks its files ready and the request `completed` in one transaction. A failure removes the reserved files and ends the request `failed`. The hourly `sweep_home_copies` expires waiting requests after 30 days, fails copies still running 6 hours after they started (the approval, or the request for a direct copy), and ends requests into closing Homes or from people who left.

**Account deletion waits for open requests.** `request_account_deletion` refuses with `pending_copies` while the person has a pending request and `copies_running` while a copy is being made. The Delete account page lists them and lets the person cancel every pending request after an explicit acknowledgement; nobody else is told. The same page lists the person's eligible items shared with a Home now (`my_shared_copyable_items`), each linking to its own copy page, so they can keep chosen items in chosen Homes first; this is optional.

## Open values

1. Category deletion is immediate and permanent (no 30-day trash step).
2. Eligible copy types: recipes, calendar events and photo albums.
3. Approvers: the Owner, every Administrator, and holders of the content's creation right.
4. An album copy holds at most 200 photos.
5. At most 50 open copy requests per person.
6. Requester outcome notices are in-app only; approvers also get email.
7. Approver email follows each approver's Approvals email setting, which is off by default.

## Consequences

- A copy is independent from the moment it exists: edits, permissions and deletion follow the Home, and nothing synchronizes with the original.
- Copying files uses the destination Home's storage quota and R2 `CopyObject` requests; no new service, dependency or paid plan was added.
- Until a file copy completes nothing appears in the Home; a job that dies leaves the request `copying` until the hourly sweep fails it.
- Category deletion cannot be undone; the page points to the export first.
- `docs/production-migrations.md` needs the new migration added by the owner's docs-only push.
