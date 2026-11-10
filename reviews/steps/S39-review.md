# S39 review: privacy dashboard and exports (`feat/privacy-exports`)

Reviewer: independent review agent (fresh context, Claude), 2026-11-10. Scope: uncommitted working tree vs HEAD (`s39.diff`), PS L528–535 and L657–712, CLAUDE.md, ARCH §10/§11/§36, S39 brief, ADR 0048. No tests were run by the reviewer; findings come from reading the code.

## Verdict: CHANGES_REQUIRED

One HIGH finding (archive build memory) blocks PR readiness. I found no cross-Home or cross-user data leak in the SQL.

## Findings

### HIGH

**H1. The in-memory archive build can exceed the default Trigger.dev machine's memory. A large media library then causes repeated crashes, and the export stays "preparing".**
`packages/jobs/src/jobs/privacy-export.ts:25,97-125,145`; `packages/jobs/src/export/zip.ts:95`; `packages/jobs/trigger.config.ts` (no `machine`).
The media budget is 150 MB. Every attachment is held in `entries`. `buildZip` then copies the whole archive once in `Buffer.concat` and again in `new Uint8Array(buffer)`, because a TypedArray constructor copies its argument. Peak memory is therefore about 3× the media, roughly 450 MB, plus JSON, CSV and the Node baseline. That is above the 0.5 GB of the default `small-1x` machine, and `objects.put` may add another buffer. The OOM is not a `PermanentJobError`, so each attempt crashes, the run is retried 3 times, and the export stays `preparing` until the 2-hour sweep. During that time the person cannot request a new export (`in_progress`). Anyone with more than about 100 MB of photos may never get an archive. The fake object store in the unit tests cannot catch this.
Remediation:

- Return the concatenated `Buffer` without a second copy.
- Drop media references as they are written.
- Set the media budget from a measured peak on the real machine, or set an explicit `machine` that stays within the free plan. That is a €0 check: confirm compute credits first.
- Add a test asserting `buildZip` makes no extra full-size copy, or a memory-bounded test with a large fake object.

### MEDIUM

**M1. Home exports (brief scope item 3, `exportHomeData`) are not built, and the deferral has no record of owner approval.**
`supabase/migrations/20261126090000_privacy_exports.sql:113`; `docs/adr/0048-privacy-exports.md:5`.
The ADR says Home exports are "left for a later step; see the brief". The brief still lists them in scope and has no deferral note. The done-condition (personal export half of the journey) is met without them. Remediation: get the owner's approval for the split and record it in the brief and roadmap, or build Home exports.

**M2. Some deletions do not invalidate a ready archive.**
`privacy_exports.sql:241-273`.
Only personal trash (`owner_user_id`), membership deletion and deactivation invalidate exports. These do not:

- Home trash (`owner_user_id` is null, so the trigger returns early) for a Home task, habit, goal or recipe that the requester's own contributions belong to.
- Hard deletes that bypass trash, for example `delete_task_comment` (tasks migration L1758), and any module that deletes rows without a trash entry.
  After any of these, the stored ZIP still holds the deleted data and stays downloadable. That breaks PS L661 and L696 ("data deletion … must … invalidate affected exports", "Never serve a stale export"). Remediation: add invalidation for Home trash rows affecting `scope_memberships` Homes and for deletes of contribution tables, or keep an eligibility fingerprint (row counts or max timestamps per category) and compare it in `data_export_intact`. Add DB tests for both cases.

**M3. The manifest does not record the selected Home scope.**
`packages/jobs/src/export/archive.ts:84-121`.
PS L662 says to "record selected categories and selected Home scopes in the private manifest". The manifest has `selection` and `categories` but no Homes. `home_contributions/homes` exists only when that category is selected, yet Home scope also filters `account/*` (home_profiles, notification preferences, quiet hours, home_preferences). Remediation: return the scope Homes (id and name) from `begin_data_export` and put them in the manifest. Add a manifest test.

**M4. Some eligible personal data is left out without being listed in the manifest or the UI.**
`privacy_exports.sql:480-867`.
Personal tables with no collector and no listed exclusion include:

- `private.dashboard_layouts`
- `private.task_templates`
- `private.task_series_attachments` (files on recurring tasks)
- `private.habit_user_settings`
- habit and goal reminder opt-outs
- `private.security_alert_preferences`
- the in-app `public.notifications` inbox

PS L671 says not to silently omit eligible categories. Remediation: collect these, or name them in `EXPORT_EXCLUSIONS`, the README and the "never included" UI list, with a reason.

**M5. An archive written after cancel can be left in storage with no deletion queued.**
`privacy-export.ts:52-56,137-151`; `privacy_exports.sql:940-949`.

- If the export is canceled or invalidated after `put` and the run then crashes before `finish_data_export`, the retry gets `begin` = `skip` and returns without re-queuing deletion.
- If `finish` runs while a deletion is in flight (object already removed but `done_at` still null), `queue_object_deletion` hits `on conflict do nothing`. The late upload then outlives the deletion job.

Either way, a personal-data ZIP stays in R2 indefinitely. Remediation:

- On `skip` with an ended status and a set `object_key`, re-queue deletion; `begin` could return the key for this.
- Have the deletion job run once more after a delay for `reason = 'export'`.
- Or make the sweep re-delete keys of ended exports whose deletion finished before `ended_at` plus a grace period.

**M6. Google-only accounts lose their category and Home choice during re-authentication.**
`apps/web/src/components/privacy/data-export.tsx:94-101,265-288`.
`ConfirmWithGoogle` navigates away. On return the form is back to its defaults: All eligible data and all Homes selected. The person can then prepare a broader export than they reviewed, without noticing, which goes against PS L660's clear review screen. Remediation: keep the pending selection, for example in `sessionStorage` (with try/catch) or in the return URL, and restore it and resume after `confirmed=data_export`.

### LOW

- **L1.** `archive.ts:46-51`: `csvCell` neutralises JSON-stringified numbers, so a negative number such as `-5` points becomes `'-5` and numeric data is corrupted. Neutralise only string values.
- **L2.** `privacy-export.ts:93-96`: media deduplication with `findIndex` is O(n²). With thousands of photos this is slow. Use a `Set` of paths.
- **L3.** The job has no hook for when retries run out. After `RetryableJobError` or an unexpected error on the last attempt, the export stays `preparing` with no failure notice for up to about 3 hours (2-hour limit plus the hourly sweep) and blocks new requests. Call `failDataExport` when the final attempt fails.
- **L4.** `tasks.ts:131`: the expiry sweep is chained after the other hourly steps inside a 90-second task. A failure earlier in the chain skips the sweep, so expired archives stay in R2 longer than 7 days. Download is still refused by `expires_at`, but removal is delayed. Run the sweep in its own try block or its own scheduled task.
- **L5.** `data-export.tsx:410`: each row has `role="status"`, so the list holds many live regions that are polled every 15 s. Keep one live region for status changes.
- **L6.** `data-export.tsx:500-522`: "Delete" on a ready export takes effect immediately with no confirmation.
- **L7.** `privacy-review.tsx`: the `dismiss` action exists in the API and the database but is not reachable from the UI. PS L533 asks to "allow dismissal and later restart".
- **L8.** `privacy_exports.sql:806-813`: `chore_submissions` matched on `contributor_id = p_me` also exports `note`, which may have been written by another person (`submitted_by`). Export `note` only when `submitted_by = p_me`.
- **L9.** `request_personal_export` lets any authenticated user request an export. That is correct while only adults exist, but S41 (children) and S43 (displays) must add an account-kind check (PS L663, L665). Note this in those briefs.
- **L10.** All Homes are preselected in the scope selector (`data-export.tsx:103`). Consider defaulting to none, or explain the default, so contributions are opted into.

## Explicit checks

- **Requirements:**
  - Met: dashboard with account, Home and device labels and links; optional review with Keep, Change, Back, Skip and Finish, and step-only progress; All eligible data or chosen categories; Home scope from current memberships only; async job; one ZIP with JSON and CSV per module and attachments; README; in-app and email ready notice without a link; 7-day expiry from generation; expiry warning; re-authentication on request and download; recheck on download; queued, preparing, ready, failed, canceled, expired and invalidated states.
  - Gaps: M1 (Home exports), M2 (invalidation coverage), M3 (manifest Home scope), M4 (silent omissions), L7 (dismissal).
  - Not yet applicable: guardian-managed and child items, and Display denial (S41–S43).
- **Cross-Home isolation:** OK.
  - Scope is limited to the caller's own membership rows. An unknown Home and a foreign Home are refused the same way.
  - Collectors filter on `p_me` and on `data_export_homes` (current matching rows only).
  - Other people appear only as `someone_else`.
  - `list_my_exports` names only Homes the requester still belongs to.
- **Permissions:**
  - The `authenticated` RPCs act on `auth.uid()` only.
  - The build functions are `service_role` only and revoked from `public`, `anon` and `authenticated`.
  - `private.*` helpers are revoked from `public`.
  - `private.data_exports` and `private.privacy_reviews` have RLS on and no grants.
  - Download needs a live session, a fresh `data_export` grant bound to the session, the requester's own ready and unexpired export, and an intact scope.
- **Secrets:**
  - The object key never reaches the browser; only a 60-second GET-only presigned URL with a neutral filename and `no-store`.
  - Logs carry codes and counts only.
  - No credentials or tokens are collected.
- **Input validation:**
  - Zod strict schemas on every route, with a body limit and same-origin JSON (CSRF).
  - Export ids are checked as UUIDs.
  - The database re-validates categories (catalogue subset, duplicates removed, null or empty rejected), Home count at most 50, step names, failure code format and sweep limit.
  - Archive paths are regex-checked before ZIP naming, and the ZIP writer rejects `..`, absolute and duplicate names.
- **Migration safety:**
  - Additive, apart from replacing two CHECK constraints by widening them, which is safe on existing rows.
  - `authorize_account_change` is replaced with a superset.
  - Every SECURITY DEFINER function sets `search_path = ''` and uses schema-qualified names.
  - The advisory lock serialises request limits correctly.
  - Rollback: drop the new functions, tables and triggers, and restore the two previous CHECK constraints.
- **Test coverage:**
  - DB tests cover listing, limits, scope, job role grants, build, download recheck, membership and trash triggers, cancel, fail, expiry, stale preparation, deactivation and review. The brief reports 70 assertions; not re-run here.
  - Job unit tests cover the job, ZIP and CSV.
  - Component tests cover en and nl with axe.
  - The E2E test covers the done-condition journey.
  - Gaps are listed below.
- **Accessibility:**
  - Labelled fieldsets and legends, `aria-describedby` hints, focus moved to the step heading, a progress element with a label, announced alerts, and axe in E2E and in components.
  - Problems: L5 and L6.
- **Performance:** H1 and L2. Collectors run one RPC per category with ordered aggregates; acceptable at MVP scale.
- **Maintainability:**
  - Clear comments.
  - The category catalogue is duplicated in SQL, the jobs package and the web catalogue, and a unit test should pin all three to the same list.
  - The 150 MB budget in the ADR and the 500 MB in the brief's open values disagree; the owner needs to confirm one.

## Remaining risks and test gaps

- No test exercises a near-budget archive for memory (H1). No test reads the produced ZIP with a real `unzip` or ZIP library to check structure; the E2E test only checks the signature and the names.
- Collector tests are thin for calendar, recipes, meals, habits and goals, media and account. Field-level exclusion of other people's content is tested mainly for tasks.
- No tests for: invalidation by Home trash or comment deletion (M2), late upload after cancel (M5), Google re-authentication flow for export (M6), and retry exhaustion (L3).
- The 60-second presigned URL can be reused within its lifetime; this is accepted by the storage strategy.
- Decisions for the owner:
  - Home export deferral (M1).
  - Media budget and machine size (H1; €0 compute credits).
  - Brief open values 1–5, which are still marked "awaiting approval".

## Fixes after review (implementer, verified locally)

- **H1 fixed.** `buildZip` returns the concatenated `Buffer` without copying it again. The job drops its media references once the archive is built, before the upload. The media budget is now 100 MB, so the peak is about twice that plus Node on the default 0.5 GB machine. No larger machine was set (€0).
- **L3 fixed.** On the last attempt, a storage outage now fails the export (`storage_unavailable`, in-app notice) instead of leaving it `preparing`. A new test covers three runs. An out-of-memory crash still relies on the 2-hour sweep.
- **L1 fixed.** Numbers and booleans are written as they are, and only text is neutralised. The test now covers this.
- **L2 fixed.** Media are deduplicated with a `Set`.
- **M3 fixed.** `begin_data_export` returns the selected Homes (id and name), and the manifest records them as `homes`. The DB test and the job test cover this.
- **M6 fixed.** Before leaving for Google, the choice is saved in `sessionStorage` for this tab only. It is restored, checked against the schema and the current Homes, and removed when the page returns with `confirmed=data_export`. A component test covers this.
- Checks: format, lint and typecheck pass for jobs and web. `privacy-export.test.ts` passes 10 of 10, the web privacy tests pass 8 of 8, and `privacy_exports.test.sql` passes.
- **M2 fixed.** Moving a Home item to trash invalidates exports that hold contributions in that Home. A delete trigger on every exported table invalidates the exports of the person the row belongs to, directly or through its parent. DB tests cover a deleted contribution and Home trash.
- **M4 fixed.** These are now collected: security alert preferences, habit settings, the personal dashboard layout, the in-app notifications (kind and dates; their details are listed as excluded), reminder opt-outs, task templates, attachments of recurring tasks (with their files), and habit and goal reminders.
- **M5 fixed.** Thirty minutes after an export ends, the hourly sweep queues its archive for removal once more. A DB test covers this.
- The migration was rebuilt from scratch. `privacy_exports.test.sql` passes, and so do the tasks, shopping, task-attachments, photos, goals, habits, meals, points and personal-points SQL tests.
- Open for the owner: M1 (the split decision) and L4–L10.

## Part 2 review: Home exports

Reviewer: independent review agent (fresh context, Claude), 2026-11-10. Scope: the Home-export parts of the full S39 diff (`s39-full.diff`): migration `20261126090000_privacy_exports.sql` (grants table, `can_export_home`, `data_exports` kind/home_id, `data_export_intact`, invalidation triggers, `request_home_export`, `list_home_export_access`, `set_home_export_access`, `export_member`, `collect_home_category`, `collect_data_export`, `begin_data_export`, `authorize_export_download`), `tests/db/rls/privacy_exports.test.sql` (Home exports section), the jobs package, the web routes, pages, components, `google-reauth.ts` and ADR 0048. The DB test file was run on the local disposable DB and passes. I also ran ad-hoc probes on the same fixtures; they are described under H1 and the checks below. The probes were not added to the repository.

### Verdict: CHANGES_REQUIRED

One HIGH finding blocks PR readiness: a ready Home export stays downloadable after the requester loses access at the module level, for example pet medical access. I reproduced it on the DB. I found no cross-Home leak and no privilege escalation in the grant flow.

### Findings

#### HIGH

**H1. A Home export is not checked again against the requester's module and field access at download. A member who loses pet medical access, or similar access, can still download the archive that holds that data.**
`supabase/migrations/20261126090000_privacy_exports.sql:252-262` (`data_export_intact`), `:775-822` (`authorize_export_download`); `docs/adr/0048-privacy-exports.md:33`.
For a Home export, `data_export_intact` checks only three things: the account is not deactivated, the membership row is the same, and `can_export_home` holds. `collect_home_category` applies module rules when it collects: `pet_medical_can_view`, `calendar_level`, `shopping_access`, `meal_access`, `habit_access`/`goal_access`, `photo_access`, `can_review_chores`, `can_manage_rewards`, `can_view_point_account`, `can_see_redemption` and `can_see_recipe`. None of these is checked again later, and no trigger invalidates an export when they change.
Probe: the Owner gives Ann `pet_medical_access` 'view'. Ann's `pets` Home export is built and is ready, with "Rex medical note" in it. The Owner deletes the access row. The export stays `ready`, and `authorize_export_download` returns the object key.
This breaks PS L661 ("permission revocation … newly private shared records must block or invalidate affected exports. Never serve a stale archive after access changes") and PS L703 ("Enforce both export permission and underlying data access at generation and download time"). It also contradicts the ADR's own claim that "a member who later loses access loses the export too". The same gap applies to these changes:

- calendar access lowered to none;
- a shopping list's `member_access` lowered;
- a recipe unpublished;
- a revoked `manageHomeShopping`, chore-review or reward-management capability.

Remediation, either of:

- In `begin_data_export`, store an access fingerprint for kind 'home' on `data_exports`. It should hold the boolean or level of each module gate the collector used, plus the visible shopping-list and recipe ids, or a hash of them. Recompute it and compare it in `data_export_intact`, which runs at collect, finish and download.
- Add invalidation triggers on `pet_medical_access`, `home_calendar_access`, the capability grants, `shopping_lists.member_access`/status and `recipes.status`/shares.

Add the probe above as a DB test, and correct ADR line 33.

#### MEDIUM

**M1. Trashed chores still export their occurrences and submissions.**
`privacy_exports.sql:1402-1440` (`chores/occurrences`, `chores/submissions`).
Two delete paths set only `chores.deleted_at` and leave the occurrence rows' `deleted_at` null:

- deleting a one-off chore (`chores.sql:2484`);
- deleting a whole series with no history (`chores.sql:2534`).

The collector filters occurrences only on `o.deleted_at is null` and does not filter submissions at all. Any Home export made after such a delete therefore holds notes, skip reasons, assignees and submission notes of a chore that is in trash. The app hides these: `list_home_chore_history` requires `c.deleted_at is null`. This also contradicts README_HOME ("Not included: … items in trash").
Remediation: join `private.chores c` with `c.deleted_at is null` for occurrences and submissions, and require `o.deleted_at is null` for submissions. Add a DB test that trashes a one-off chore and then exports.

**M2. The notifications and emails for a Home export send the person to the wrong place and describe the wrong data.**
`privacy_exports.sql` (finish/sweep `notify_user` with `account.data_export_ready` / `_expiring` / `_failed`); `packages/email/src/notification-messages.ts:157-163`; `apps/web/src/privacy/server.ts:63-73`.
The email says "The export of your personal data … download it from Settings, Privacy, Export your data". That page lists only `kind = 'personal'` (`listMyExports("personal")`), so the person cannot find a ready Home export from the link or the instructions. It is also inaccurate to call a whole-Home archive "your personal data".
Remediation: use notification kinds, or a payload, that depend on the export kind and name the Home's export page (`/homes/{id}/export`), with matching en/nl copy. Alternatively, also list Home exports on the personal page. Add a test.

**M3. Invalidation is so broad that any member, and routine edits, can keep voiding the exporter's Home exports, and the voided requests use up the 3-a-day limit.**
`privacy_exports.sql:277-302, 333-380, 386-473, 595-606`.
Every queued, preparing and ready Home export of the Home is ended when any of these happens:

- any member leaves;
- any Home item is moved to trash;
- any hard delete on 39 tables.

Hard deletes include routine system operations:

- a chore schedule edit removes untouched future occurrences (`chores.sql:2225, 2387`);
- vacation orphan handling (`home_vacations.sql:607`);
- restoring a calendar occurrence deletes its exception (`calendar.sql:1227, 1291`);
- removing a photo from an album.

Canceled and invalidated requests still count toward `data_export_daily_limit`. So, in a busy Home:

- a build can be voided while it is still queued, although the collector reads the current state anyway;
- a ready archive can be voided before it is downloaded;
- a Member without export permission can lock the Owner out for 24 h by trashing three items at the right moments.

Remediation:

- Do not invalidate `queued` exports for 'data_changed', since nothing has been collected yet.
- Do not count 'data_changed' invalidations toward the daily limit, or give the person a fresh request.
- Exclude system deletions of untouched, never-shown rows: future chore occurrences and calendar exceptions that are being restored.
- Record the trade-off in the ADR.

#### LOW

**L1. `list_my_exports` returns the 20 newest exports of both kinds and all Homes, and the web filters them afterwards by kind and Home.**
`privacy_exports.sql:709-737`; `apps/web/src/privacy/server.ts:73`; `export/page.tsx:63-64`.
A person with several Homes can make up to 3 requests a day per Home plus 3 personal ones. That can push a ready Home export out of the window, and it then disappears from that Home's page while it is still downloadable. Remediation: give the function `p_kind`/`p_home_id` parameters and filter in SQL, or apply the limit per kind and Home.

**L2. A grant row survives promotion to Owner.**
`privacy_exports.sql:61-87`, ownership transfer.
If a granted Member becomes Owner and is later demoted, for example by transferring ownership back, the old `home_export_grants` row quietly gives exportHomeData again, and the current Owner never chose it. Remediation: delete the grant row when the role becomes 'owner'. A trigger on `home_memberships` role update would do this. Add a test.

**L3. Cancelling a Home export is not audited.**
`privacy_exports.sql:742-762` (`cancel_my_export`).
The request (`home.export.requested`) and the download (`home.export.downloaded`) write Home audit events, but cancel and invalidation do not. PS L703 asks for audit events. Remediation: audit `home.export.canceled` when kind = 'home'.

**L4. Test gaps (see the list below).**
`tests/db/rls/privacy_exports.test.sql:470-622`; `apps/web/src/auth/google-reauth.test.ts`.
`isReturnPath` and `confirmedPath(…, returnPath)` have no unit tests, although they guard the redirect. The two new Route Handlers have no tests of their error mapping.

### Explicit checks

- **Requirements:** Done:
  - a separate `exportHomeData` permission: the Owner always has it, and the Owner grants it to Administrators or Members;
  - the same async/ZIP/7-day pipeline;
  - re-authentication before request and download (shared `data_export` grant);
  - 3 a day and 1 in progress, per Home and requester;
  - invalidation on leaving or removal, Home deletion (cascade), deactivation, losing the permission (grant removed, role change), trash and delete;
  - personal items shared into the Home excluded;
  - other members shown by their Home name only;
  - request and download audited.

  Gaps: module-level revocation (H1); trashed chores (M1); notification routing (M2). The done-condition, the personal half of the E2E journey, is not affected by these.

- **Cross-Home isolation:** OK.
  - `request_home_export` resolves the membership from `(p_home_id, auth.uid())`, and a non-member gets 42501/'homes', mapped to 404.
  - `set_home_export_access` looks the target up by `m.id = p_membership_id and m.home_id = p_home_id`. A probe with a membership id from another Home returned `not_found`.
  - `collect_home_category` re-checks membership, and every query is scoped to `p_home`. Child tables are joined to a parent scoped to the Home.
  - `list_my_exports` names a Home only while the membership row matches.
- **Permissions:**
  - `set_home_export_access` checks Owner status after `lock_home`, refuses an Owner target, and the grants table has an FK to the membership with cascade.
  - No path lets a non-Owner write grants. Grants are private, have RLS on and are revoked from public.
  - `can_export_home` is SECURITY DEFINER, uses `search_path=''` and is revoked from public.
  - Collectors and job functions are revoked from public/anon/authenticated; `begin`/`collect` are granted to service_role only.
  - All new functions use `set search_path = ''` and schema-qualified names.
- **Secrets:** None added. Object keys are returned only to the server route. README and manifest contain no account ids or emails; `export_member` never returns an id.
- **Input validation:**
  - Routes check the homeId UUID, a Zod body schema, same-origin JSON and a size limit.
  - The SQL validates categories against `home_export_categories()`, and the CHECK constraint on `data_exports` depends on the kind.
  - `returnPath` is safe from open redirects: it must match the anchored regex `^/homes/<uuid>/export$`, both in `confirmedPath` and in the pending-reauth Zod schema, and it is resolved against `window.location.origin`.
- **Migration safety:** `data_exports` is new in this step, so there is no backfill. The constraint `(kind='home') = (home_id is not null)` and the `ON DELETE CASCADE` on home_id are correct. Trigger identifiers in the dynamic `format(%I)` come from a literal array.
- **Test coverage:** Covered: refusal without the permission, a non-member Home, the Member's view of access, Owner-only granting, audit, the listing, one in progress, medical excluded and included, every category collecting, revoke invalidation, and invalidation when a member leaves.
  Missing:
  - the Home download path and its audit;
  - the per-Home daily limit;
  - Home trash or hard-delete invalidation of a Home export;
  - a forged cross-Home membership id;
  - a re-join not restoring the grant;
  - visibility tests for chore submissions, a shopping list without access, calendar level none, and other members' point accounts;
  - H1 and M1 scenarios;
  - unit tests for `returnPath`, and route tests.
- **Accessibility:** OK.
  - The access form uses a labelled Checkbox with a description, and announces success and error through `FormAlert announce`.
  - The category and scope controls are in a fieldset with a legend and `aria-describedby` hints.
  - The not-permitted state is an info alert.
  - Minor: the Save button is disabled until something changes, which is acceptable.
- **Performance:**
  - 39 per-row AFTER DELETE triggers each run `to_jsonb(old)`, a dynamic parent lookup by PK for child tables, and an indexed probe of open exports (partial `data_exports_open_idx`).
  - This adds cost to bulk deletes: Home or account cascades, trash purges, and chore regenerations. It is bounded, because the open-export set is tiny, but it should be measured on a large Home deletion.
  - The trash trigger calls `data_export_homes(e)` for each open personal export, which is fine.
  - `export_member` runs once per row in large collectors (a subquery per person reference). That is acceptable for MVP sizes; a CTE map of members would be cheaper.
- **Maintainability:** The collectors repeat each module's visibility rules in one large function, so future module changes can drift from it. Consider a comment or a test in each module's migration that points to `collect_home_category`. The ADR wording must match the behaviour after H1 is fixed.

### Remaining risks and test gaps

- The collector duplicates visibility logic. Any later module change, such as new private fields or new per-member visibility, must update `collect_home_category`, and nothing enforces that.
- Pet care activities (S32b), task and chore templates, and chore proposals are not exported. That is a completeness gap, not a leak. The README and manifest should list them as not included, or they should be added.
- The 'home' category's members list shows roles and names of all current members to any granted Member. This matches the in-app directory, but the owner should confirm it.
- No E2E test covers a Home export: grant, request, build, download and revoke. The step's done-condition does not require one, but it would catch M2.
- The memory concern from part 1 (H1 there) applies equally to Home exports that contain photo libraries, which are likely the largest archives.

## Fixes after the part 2 review (implementer, verified locally)

- **H1 fixed.** `private.home_export_access(home, user, categories)` returns the module gates and the visible recipe, shopping list, point account and redemption ids for the export's categories. `begin_data_export` stores it in `data_exports.access_snapshot`; `finish_data_export` widens it to what is visible at finish. `data_export_intact` (collect, finish, download, sweep recheck) requires the current access to contain the snapshot. DB test: Ann gains medical access while preparing (export stays), the ready export records `pet_medical`, the access is removed, the download returns nothing and the export is invalidated with `access_changed`.
- **M1 fixed.** Chore occurrences and submissions join their chore and require `deleted_at is null` on both. DB test with a trashed chore.
- **M2 fixed.** Ready, failed and expiring notices of a Home export carry the Home (`notify_user` home id); `notificationPath` sends them to `/homes/{id}/export`, which the email button also uses. In-app and email copy no longer say "personal data" or name Settings. DB and domain tests.
- **M3 fixed in part.** `end_data_export` no longer ends a queued export for `data_changed`. Home exports invalidated with `data_changed` don't count toward the daily limit (personal exports unchanged: their changes are the person's own). Broad invalidation of preparing and ready Home exports is kept on purpose (never serve a stale archive) and recorded in the ADR. DB test.
- **L1 fixed.** `list_my_exports` keeps the 20 newest per list (personal, and each Home).
- **L2 fixed.** Becoming Owner removes the person's grant row.
- **L3 fixed.** Cancelling a Home export audits `home.export.canceled`. DB test.
- **L4 in part.** Unit tests for `isReturnPath` and `confirmedPath` with a return path. Route Handler tests are still missing (the DB tests cover the functions behind them).
- Checks rerun: DB tests for privacy exports, notifications, pets, chores, roles and ownership, ownership recovery, homes, account lifecycle and trash pass; web (97), jobs (320), domain (14) and email (199) tests pass; web typecheck and lint pass.
