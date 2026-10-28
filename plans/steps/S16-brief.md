# S16 · Trash and recovery — feature brief

**Branch:** `feat/trash-and-recovery`, from `main` at `f925f1c` (S15 merged as PR #26).
**Sources:** build plan S16; PS L2281–L2327 (trash placement, central personal and Home trash, parent items with attachments, early permanent deletion, Home file permissions) and L820–L840 (7-day recovery, conflict handling, bulk restore); ARCH §36; S15 brief (files are already `deleted` and counted for 7 days, with a purge job).

**Done when:** a sample record type deletes, restores (with a conflict case) and purges after the window; deleted files still count against quota.

## Actors and permissions

- **Personal trash:** only its owner. **Home trash:** a current Home member sees and acts on (a) what they deleted themselves, and (b) everything in that Home's trash if they are the Owner or an Administrator granted `manageHomeSettings` (new engine action `home.trash.viewAll`). The per-module permission matrix is open in the spec, so this is a generic default that module steps (S18+) may refine through the per-type rule. A person who may not see an entry gets the same "not found" as for an entry that does not exist: no counts, previews or existence leaks.
- Entries disappear from view the moment membership ends.

## Design

1. **Database** (one migration):
   - `private.trash_entries`: owner (personal user or Home, exactly one), `module`, `item_type`, `subject_id`, `label` (snapshot shown in the list, cleared when purged), `deleted_by`, `deleted_at`, `expires_at` (= deleted_at + 7 days, from the same `recovery_days` setting as files), `status` (`trashed`, `restored`, `purged`). One trashed entry per subject.
   - `private.trash_entry_files`: files that went to trash with an entry (so a restore knows which ones to bring back).
   - Reference **sample record type** `private.trash_samples` (name, optional `slot` unique among active items of the same owner, optional `parent_id`, optional `file_id`). Not reachable through the API: it is the worked example module authors copy and what the tests exercise.
   - Generic `private.trash_move(...)`: creates the entry, puts the item's **exclusively** attached files into the file trash (still counted), enqueues a `trash-entry-purge` job delayed to `expires_at`.
   - Per-type hooks (`conflict`, `restore`, `purge`) dispatched by `item_type`. Sample conflicts: `slot_taken` (resolution `clear_slot`), `parent_unavailable` (resolution `detach_parent`). Same names alone are never a conflict.
   - Public functions (`authenticated`): `list_trash(home, module, item_type, from, to)`, `restore_trash_entries(ids, resolutions)`, `purge_trash_entries(ids)`, `empty_trash(home)`. Service role only: `purge_expired_trash_entry(id)` for the job.
   - Restore is per item: `restored`, `needs_resolution` (with the conflict kind), `expired`, `not_found`, `failed`. Never blocks the others, never overwrites active data, repeat requests never duplicate. Files already purged are dropped from the restored item and reported (`attachments_lost`). A restored file keeps its original pool charge (no double count).
   - Early purge/empty uses the same per-item permission check at execution; unauthorized entries are skipped, never reported. Releases storage through the S15 purge path. Audited by id.
2. **Job** `trash-entry-purge` (ADR 0017 outbox): re-checks at run time; expired and still trashed → purge row and exclusive files; restored or already purged → no-op.
3. **API** (`/api/v1/trash`, same CSRF/JSON/size checks as storage): `GET ?homeId&module&itemType&from&to`, `POST /restore`, `POST /purge` and `POST /empty` (both need `confirm: true`).
4. **Pages:** `/settings/trash` and `/homes/[homeId]/trash`, linked from personal settings and Home settings (no sidebar entry). Filters module, item type, deletion date; rows with label, deleted date, "recoverable until"; select, Restore selected, Delete permanently (confirmation dialog stating it cannot be undone), Empty trash (dialog naming scope, pool and count); result summary (restored / needs resolution / no longer available / failed) in a live region; inline conflict resolution; empty, loading, error and expired states; return link to the originating settings screen; nl and en.

## Tests

- **Database** (`trash.test.sql` plus a two-connection race test): tables unreachable; delete→trash→restore round trip; conflict slot and parent with resolution; same name no conflict; expired not restorable; cross-Home and cross-user invisibility; plain member sees only own deletions; revoked membership; bulk mixed results; shared file stays; exclusive file counted while trashed, released on purge; restore doesn't double count; lost attachment reported; early purge permissions; job purge idempotent and no-op after restore; concurrent restore vs purge, double restore.
- **Unit:** schemas, routes (CSRF, unauth, invalid, confirm required, mapping), engine action, job, components with axe.
- **Playwright:** personal and Home trash: list, filter, restore, conflict resolution, bulk, delete permanently with confirmation, member without rights sees own only, keyboard and axe in both themes.

## Out of scope

Real modules' own delete flows (tasks S18, recipes S24 …); whole account/Home 30-day recovery (S40); recurring/external-sync item rules (module steps); attachment upload purposes (S19+).

## Defaults picked (owner may override)

- Home trash visibility as above (own deletions, or Owner / `manageHomeSettings` Administrators see all).
- Sample type is test scaffolding shipped in the migration; dropped or kept as reference when tasks land.
- Bulk size cap: 100 restore/purge ids per request; Empty trash handles up to 200 entries per call and the page offers to continue.
