# S31 pets, medical history and medical access: independent review

- **Branch:** `feat/pets` (uncommitted working tree on top of `main` at `a06039c`).
- **Read:**
  - the diff (`s31.diff`, about 9,600 lines);
  - `supabase/migrations/20261116090000_pets.sql` in full;
  - the earlier functions it wraps, recreates or relies on: `authorize_file_read` (S24 version), `expire_upload` (S24 version), the S16 trash core (`trash_move`, `trash_restore_one`, `trash_purge_one`, `list_trash`, `restore_trash_entries`, `purge_trash_entries`, `empty_trash`, `audit_trash_entry`, base `trash_item_restore` / `trash_item_purge` / `trash_resolve`), `retire_file`, `home_storage_usage`, `has_home_capability`, the `home_memberships` table and every place that updates or deletes memberships (role change, removal, leaving, ownership transfer and recovery), and `attach_task_file` (for the upload-row locking pattern);
  - `plans/steps/S31-brief.md`, `docs/adr/0041-pets.md`, `CLAUDE.md`;
  - `docs/product/Modules.md` lines 73–112 only (the spec was not read otherwise);
  - the web layer: `apps/web/src/pets/*`, every new route under `apps/web/src/app/api/v1/{pets,pet-medical-entries,pet-medical-attachments,homes/[homeId]/pet-medical-access}`, the finalize route changes, the pet, entry and member pages, `pet-page.tsx`, `medical-entry-page.tsx`, `medical-entry-view.tsx`, `pet-medical.tsx`, `medical-access-form.tsx`, and the trash view and filter changes;
  - `packages/domain/src/permissions/pets.ts` and the `home.ts` changes;
  - `tests/db/rls/pets.test.sql` in full; the test names in `pets.test.tsx`, `pets.test.ts` and `tests/e2e/specs/pets.spec.ts` (the e2e spec was read, not run).
- **Spot-checked `docs/production-migrations.md`:** the migration file is contained byte-for-byte in the consolidated block (starting at line 45825). The reset version list contains `20261116090000`. Every new `public` function appears in the reset list.
- **Ran:**
  - `tsc --noEmit -p .` in `apps/web`: clean.
  - Vitest in `apps/web`: `src/pets`, `src/components/pets`, `src/app/api/v1/pets`, `src/app/api/v1/files`, `src/components/shell`, `src/components/trash`. 12 files, 159 tests, all green.
  - Vitest in `packages/domain`, `src/permissions`: 9 files, 2914 tests, green.
  - ESLint on every changed web path: clean.
  - Prettier `--check` on every changed or new TS, TSX, JSON and MD file: clean.
  - en/nl message key parity: no key missing on either side.
  - DB suite: `bash /home/builder/run-db.sh "rls"` against the fallback Postgres, with a fresh database and every migration applied. 31 files and 138 tests passed, including `rls/sql-files.test.ts`, which runs `tests/db/rls/pets.test.sql`. This was the `rls` subset; the implementer's 151 covers the whole DB suite.
  - Grant check, by reading: every new `private` function name contains `pet` and is revoked from `public`, `anon` and `authenticated` by the final loop, as are the renamed `*_before_pets` functions. No existing private function name contains `pet`, so the loop revokes nothing it should not. The new `public` functions are revoked from `anon` and granted to `authenticated`, and `expire_upload` to `service_role` only. Every security-definer function has `set search_path = ''` and schema-qualified references. The seven tables have RLS enabled and every privilege revoked. The DB test asserts the denials.
  - Not run: Playwright (the implementer reports 188 passed), and no ad-hoc SQL probes. The finding below was established by reading the code paths end to end.

**Verdict:** `CHANGES_REQUIRED`

One HIGH finding: the trash shows the number of files in a deleted pet's entry, and that number counts the medical attachments. An Administrator with `manageHomePets` but without medical access can therefore see whether a pet has medical documents, and how many. The brief's leak rules and the spec's "avoid leaking protected information through … counts" forbid exactly that.

Apart from this, the core design is sound and well tested:

- sensitive data is in separate tables, with no table grants;
- one helper (`pet_medical_level`) is rechecked on every read, write and file authorization;
- every no-view path answers `null` or `not_found`, the same as a missing record;
- the grantor rules are enforced under the Home lock;
- the grant is tied to the membership by a cascading foreign key;
- trash entries for entries and attachments are visible only to medical managers.

## Findings

### BLOCKER

None.

### HIGH

**H1. A pet's trash entry reveals how many medical attachments the pet had.**

- `supabase/migrations/20261116090000_pets.sql:871-879` (`delete_pet`) puts the photo **and every active medical attachment's file** into the pet's trash entry (`trash_entry_files`).
- `public.list_trash` (`20261024090000_trash_and_recovery.sql:460-497`) returns `file_count` for every entry the caller can see.
- `private.can_see_trash_entry` (`:1757-1767`) shows a `pet` entry to every pet manager, with no medical check.
- `apps/web/src/components/trash/trash-view.tsx:328` renders `t("withFiles", { count: entry.fileCount })`.

The same applies to `attachments_lost` in the restore answer (`trash_item_restore`, `:1895-1904`, `trash-view.tsx:513`). It counts lost medical files for a person who has no medical view, although it rarely differs from 0 inside the 7-day window.

_Impact:_ Bob is an Administrator with `manageHomePets` and no medical access. He deletes Rex and sees "with 4 files" in the trash, where a pet with only a photo shows "with 1 file". He learns that Rex has three medical documents. The brief's leak rule says: "A person without medical view never receives … their count, existence". The spec (Modules.md, medical access) says: "avoid leaking protected information through titles, counts, thumbnails". This is the step's done-condition: "medical information is hidden from members without permission".

_Remediation:_ do not count medical files in what a non-medical viewer receives about a pet entry. Either of these works:

- keep the pet's `trash_entry_files` for the photo only, and record the medical attachment files in a pets-owned side table (or a second trash-entry link) that `trash_item_restore` and `trash_item_purge` also process; or
- make `list_trash` (or a pets wrapper around the count) count only files whose purpose is not `pet_medical_attachment` unless `pet_medical_can_view` holds, and do the same for `attachments_lost`.

Add a DB assertion: an Administrator with `manageHomePets` and no medical access deletes a pet with a photo and two attachments, and `list_trash` shows `file_count = 1`, the same as for a photo-only pet. Add a component or e2e check that the trash row shows no different file count.

### MEDIUM

**M1. A pet manager without medical access can restore, and permanently purge, a pet's medical records.**

- `delete_pet`, pet restore and pet purge need only pet manage (`:847-883`, `:1763-1764`, `:1929-1959`). Restore brings back the sensitive details, entries and attachments. Purge, or simply letting the 7-day window expire, destroys them for good, with no medical permission.
- The spec says: "Require explicit authorization … for restoring deleted sensitive records", and distinguishes permission to view from permission to "create/edit/delete" medical information.
- The brief chose this behaviour (default 5, "Deleting a pet takes its medical data into the same trash entry"), and the brief notes the defaults are still pending the owner's confirmation.

There is a real trade-off. Requiring medical manage for a pet that has medical data would itself reveal that the data exists, unless the rule applies to every pet, whether or not it has records.

_Remediation:_ ask the owner to confirm explicitly that pet managers may delete, restore and purge medical data along with the pet. One alternative: deleting a pet needs pet manage, but restoring or purging it early needs pet manage **and** medical manage, for every pet, so the rule reveals nothing. Record the decision in ADR 0041.

**M2. The DB tests miss several cases the brief lists.**
`tests/db/rls/pets.test.sql` has no case for:

- **Ownership transfer.** The new Owner gets implicit `manage`. The former Owner keeps no access unless granted. Brief Tests: "ownership transfer".
- **Limits.** 50 pets, 1000 entries, and 10 attachments per entry, including uploads in progress (brief: "attachment limits").
- **Restore conflicts** `pet_limit`, `entry_limit`, `entry_in_trash` and `pet_attachment_limit`. Only `pet_in_trash` is covered.
- **The `expire_upload` wrapper.** It should retire a finished but unapplied photo or attachment, and forget a failed one.
- **An Administrator granting `manage` to another Administrator, and a Member with `manage` writing.** Only Bob, an Administrator, writes.
- **The H1 count.**

The code for these paths looks right on reading, but the brief names several of them as tests. _Remediation:_ add these cases. The transfer case can use `tests.act_as_owner()` to swap the roles, as other suites do, or the transfer RPCs.

**M3. Medical access is not withdrawn from views that are already open.**
The brief and ADR say a change works "on the next request", and the server does recheck everything.

- The spec says permission changes must be "effective immediately, including on open views and downloads".
- An open pet or entry page keeps showing the details and the history until it is reloaded. Downloads are rechecked, which is correct.

_Remediation:_ ask the owner to accept "next request" for this step (and record it in ADR 0041), or add a light refresh. For example, re-read the pet when the window regains focus or on a timer, and drop the Medical section when `medicalAccess` becomes null.

### LOW

**L1. `attach_pet_medical_file` and `set_pet_photo` do not re-read the upload row under the lock** (`:1482-1512`, `:1331-1351`).

`attach_task_file` re-reads its upload row `for update` under the task lock. These two functions read the upload row before `lock_pet_medical_entry` or `lock_pet`, then delete it and insert or apply the file without checking how many rows the delete removed.

- Two concurrent finalizes of the same ready file: the second waits on the pet lock and then fails on the `pet_medical_attachments_file_key` unique index (23505, answered as a 500). The person sees a failure although the document was saved. A retry then answers `attached`.
- `expire_upload` running at the same moment can retire the file and delete the upload row between the read and the insert. The attachment row then points at a `deleted` file: it is hidden by `f.status = 'ready'` in `pet_medical_entry_json`, but `attach_pet_medical_file` and `trash_conflict` count it towards the limit of 10. For a photo, the pet's photo points at a retired file.

Both windows are narrow.

_Remediation:_ after taking the lock, `select … for update` the upload row again and answer as for the retry path when it is gone. Re-check `v_file.status = 'ready'` under the pool lock, or lock the file row.

**L2. `lock_pet` takes `for update` on any pet id before checking access** (`:349`). A signed-in person who knows a pet id in another Home can briefly hold its row lock through any write RPC. This is the same pattern as S30c L5. Ids are random UUIDs, so the effect is contention only. _Remediation:_ check `pet_access` on an unlocked read first, then lock.

**L3. A DB assertion counts audit rows across the whole database** (`tests/db/rls/pets.test.sql:242-243`): `count(*) = 2 … where action = 'pet.medical_access.changed'`. It fails on a database where an earlier run (e2e) changed medical access. This is the same issue as S30c L1. _Remediation:_ filter by `home_id = tests.i('home-a')`, or add `occurred_at = now()`.

**L4. Breed allows 120 characters; the brief says ≤ 80.** The SQL (`pet_limit('short')`, `:136-140`, `:745`) and `PET_LIMITS.short` agree with each other, but not with the brief's model ("breed (≤80)"). _Remediation:_ use 80 for breed, or correct the brief.

**L5. Identifiers in `create_*` answers can confirm that an id exists elsewhere.**

- `create_pet` answers `id_taken` before the permission check, so a Member can tell that an id exists in any Home (`:678-683`).
- `create_pet_medical_entry` does the same for entry ids, for anyone with medical view (`:1016-1021`).

Ids are client-generated UUIDs, so this is theoretical. It matches earlier modules.

**L6. Home storage managers see medical uploads through the pool totals.** Medical files count towards the Home pool (brief). A storage manager without medical view can see `used_bytes` change when a document is added. This is accepted by the brief's design; it should be mentioned in ADR 0041's consequences.

## Explicit checks

- **Requirements (brief, ADR 0041, Modules.md L73–112):** met:
  - name-only creation;
  - optional fields with Unknown, None and empty kept distinct (`unknown_fields`, `none_fields`, with check constraints);
  - an approximate age with a recorded date, never turned into a birthday;
  - validation of dates, weight and unit, phone and email;
  - structured entries with the six types, the date window and a follow-up on or after the event;
  - Upcoming shown apart from History;
  - corrections with a revision check;
  - attachments (JPEG, PNG, WebP or PDF, 10 MB, 10 per entry), with nothing claimed saved before finalize;
  - the photo, visible to every member;
  - two separate permissions and the grantor rules;
  - 7-day trash for pets, entries and attachments, with child purge;
  - audit with ids and field names only;
  - Pets in the Home navigation and the member-page access card.

  Gaps: H1 (counts in the trash), M1 (restoring sensitive records without medical authorization, to be confirmed by the owner), M3 (open views). The done-condition journey is in `tests/e2e/specs/pets.spec.ts` (read, not run here).

- **Cross-Home isolation:**
  - Every read and write resolves the Home from the pet or entry row, never from the request, and checks membership with `pet_access` or `pet_medical_level`.
  - `list_pets` and `list_pet_medical_access` answer 42501 for a foreign Home, which maps to 404.
  - `set_pet_medical_access` matches the membership id against `p_home_id`.
  - The pages redirect a pet or entry opened under another Home's address to its own, which is reachable only by a member.
  - DB tests cover a foreign pet, a foreign entry, and Alice and Carol in Home B.
- **Permissions:**
  - Pet manage is the Owner, or an Administrator with `manageHomePets` (`has_home_capability` requires the `administrator` role, so a demoted Admin loses it).
  - Medical level is the Owner (implicit `manage`) or a row in `pet_medical_access`. It is independent of pet manage in both directions (tested).
  - Grantors are the Owner and Administrators with `managePetMedicalAccess`. Nobody changes their own level or the Owner's (tested). Grants are checked under `lock_home`.
  - Membership removal and leaving delete the grant through the composite foreign key (tested, including rejoin). Role changes and ownership transfer are `update`s, so the former Owner (now a Member) has no row and therefore no access (correct, but untested: M2).
  - `packages/domain/src/permissions/pets.ts` mirrors the SQL, is used only for the UI, and has matrix tests.
- **Leak-proofing:**
  - Without medical view, `get_pet_medical` and `get_pet_medical_entry` answer `null`. Every medical mutation answers `not_found` before anything else, including validation, which runs after the access check. A forged id gets the same answer (tested).
  - The pet list and profile carry no medical fields, counts or hints. Medical work does not bump the pet's `revision` or `updated_at`.
  - The pet page does not even read medical data without a level.
  - The entry page has a neutral title, and the audit carries no labels.
  - Medical trash entries are hidden from everyone without medical manage, including their deleter (tested).
  - `authorize_file_read` rechecks medical view (tested: revoke, then no read).
  - Exception: H1, the file count on the pet's trash entry.
- **Secrets:** none added. No service-role use in new web code. Logging uses event and code only.
- **Input validation:**
  - Zod strict objects with the same limits as SQL (except L4), date shapes, three-decimal weight, phone and email patterns, and unique Unknown/None lists.
  - SQL rechecks every field (`pet_json_*` helpers: type-checked, 22023 on anything malformed, nothing saved), and table checks back the invariants.
  - Upload type, size and name are checked in the route and in SQL. The finalize route processes by purpose: medical files go through `checkAttachment`, photos through `processCover`. `stored_type_allowed` rechecks the stored type.
- **Migration safety and rollback:**
  - Additive: constraints widened with drop/add, new tables, and capability, module and purpose lists extended.
  - `authorize_file_read` is dropped and recreated with the same signature, and its grants are re-applied. `expire_upload` and the five trash dispatch functions are renamed to `private.*_before_pets` and wrapped. Callers bind late, and no `begin atomic` bodies pin the old versions.
  - No data is changed.
  - It is forward-only, as documented. The production block is identical to the migration.
- **Trash flows:**
  - A pet takes its photo and active attachments' files.
  - Entries and attachments already in the trash keep their own entries.
  - Entry and attachment restores refuse while the parent is in the trash.
  - Restore re-runs the conflict check under the locks.
  - Lost files drop their references.
  - Purging a pet or an entry settles the open child entries first.
  - Lock order (trash entry → pet; delete takes pet → new trash entry) does not deadlock, as traced.
- **Upload pipeline:**
  - Purposes and types are extended in three places, which agree.
  - Size is limited to 10 MB.
  - The intent counts in-progress uploads towards 10.
  - Finalize rechecks rights with the user's session, and a refusal leaves the file to the expiry job, which the wrapper retires.
  - Request-id retries are scoped to the same pet or entry.
  - See L1 for the race.
- **Test coverage:**
  - Strong: 455 lines of multi-actor SQL covering the main matrix, revocation including file reads, trash visibility and restore with files, purge cascade and rejoin; route, schema, permission-matrix and component tests (with axe); the Playwright journey.
  - Gaps: listed in M2, plus H1.
- **Accessibility:**
  - The Medical section uses `aria-labelledby` with h2/h3 headings, and values are `<dl>` pairs.
  - The access control is a labelled `SelectField` with an announced `FormAlert`.
  - Remove-attachment buttons have names that include the file name.
  - The hidden file input is driven by a real button.
  - Upload failures are announced, with a retry.
  - axe passes in the component tests and in e2e.
- **i18n:** en/nl parity is complete; ICU is used for counts and sizes, and dates go through the shared formatters.
- **Performance:**
  - Lists are single queries.
  - `pet_medical_entry_json` runs one indexed attachment subquery per entry, bounded by 1000 entries per pet. That is fine for MVP, but a pet with hundreds of entries renders the whole history at once.
  - The limit counts are indexed.
  - The advisory lock is per Home for creates and restores only.
- **Maintainability:** the wrapper-by-rename pattern continues, with clear comments. The SQL limits, the TS limits and the domain matrix cross-reference each other.

## Remaining risks and test gaps

- Playwright was not run in this review; CI must run it.
- Owner decisions still pending: the S31/S31b split, the permission matrix defaults, M1 (restore and purge of sensitive records by pet managers) and M3 (open views).
- Future readers of medical data must apply the same rule: S31b widget and reminders, Household Display (S43–S44), export (S38), search and Ora. The trash and storage surfaces show that aggregate views are easy to miss (H1, L6).
- A pet with many entries loads its whole history and every attachment list on each page view. There is no pagination.

## Implementer follow-up (after this review; not re-reviewed, per the one-review rule)

- **H1 fixed.** `delete_pet` now puts only the photo in the shared `trash_entry_files`; the medical documents' files are retired and held in the new `private.pet_trash_files` (no API grants, RLS on), which `trash_item_restore` and `trash_item_purge` also process. A lost medical file on restore drops its attachment row without counting it, so `attachments_lost` reveals nothing either. `tests/db/rls/pets.test.sql` now asserts that a pet manager without medical view sees `file_count = 1` for a pet with a photo and a medical document, and that the document is not in `trash_entry_files`. RLS suite rerun: 31 files, 138 tests, green; types unchanged.
- **L4:** the brief now says breed ≤120, matching the database and the form.
- **M1, M3:** left for Ward's decision. **M2, L1–L3, L5, L6:** not changed in this step.

## Care part: independent review

**Scope:** the care part of S31 only (care schedules, occurrences, reminders, the `pet-care` widget, pet care in the vacation reminder, the interface and docs). The profile/medical part is reviewed above and was not re-reviewed.

**Read:** `plans/steps/S31-brief.md` (in full, "Care schedules" in detail); Modules.md L73–112; `supabase/migrations/20261117090000_pet_care.sql` (in full), the wrapped S22 `deliver_vacation_reminder` (diffed against `20261104090000_home_vacations.sql` L1211: only the `petCare`/`petCareUnassigned` additions differ), the trash core (`trash_restore_one`, `trash_purge_one`, `can_see_trash_entry`), `enqueue_job` (`on conflict … do nothing`); `tests/db/rls/pet-care.test.sql`; `packages/jobs` (`pets.ts`, registry, services, supabase-data, `trigger/tasks.ts`, notification-email-content), `packages/email` pet_care entries, `packages/domain` (`pet_care.reminder` path, `decidePetCareAction`); `apps/web/src/pets/{care-schema,data,route-helpers}.ts`, every care route, the activity page, `care-activity-form/view`, `care-parts`, `pet-care-widget*`, dashboard registry/content, notifications server/types/list; `tests/e2e/specs/pet-care.spec.ts` (structure). Docs: the consolidated block in `docs/production-migrations.md` is byte-identical to the migration, the reset version list contains `20261117090000` and its public function list contains all 15 new public functions; `docs/supabase-migrations.md` and `docs/development.md` have care sections.

**Ran:** `vitest run` for `src/app/api/v1/pet-care`, `src/components/pets/care.test.tsx`, `notification-list.test.tsx`, `src/dashboard` (70 passed); jobs `pets.test.ts` + `notification-email-content.test.ts` (82 passed); full DB suite `run-db.sh "" ""` (32 files, 152 tests, green; types up to date). en/nl key sets compared: identical. Not rerun: lint, typecheck, Playwright, other unit suites (implementer-reported green).

**Verdict: CHANGES_REQUIRED** (one HIGH).

### HIGH

- **H1 — A schedule change "from" a date beyond the created horizon silently drops care.** `20261117090000_pet_care.sql:1020` retires the head part with `next_date = null` and `until_date = v_split - 1`, and `advance_pet_care_activity` (`:419`) only ever advances the head part (as do `advance_pet_care_home`/`advance_all_pet_care`, which join `superseded_at is null`). Occurrences exist only up to today+7, so when `v_split` is later than the old part's `next_date` (the form lets anyone pick any `from`, `care-activity-form.tsx:276-284`; `updateCareSchema.from` and the database put no upper bound on it), the old rule's dates from `next_date` to `v_split - 1` are never created: no occurrence, no reminder, nothing in the widget, no error. Example: a daily medication, edited on day 0 "from day 20 on" → days 8–19 have no care at all. This breaks the spec's "edit … future series" without losing scheduled care. Remediation: keep the retired part's `next_date` (`pet_care_part_next` already stops at `until_date`) and make the three advance functions iterate every part with `next_date is not null` (not just the head), or refuse/clamp a `from` later than the head's `next_date`. Add a DB test that advances "today" past the old horizon and finds days 8–19 created once each. `vacation_pet_care` (`:1449`, head part only) needs the same treatment.

### MEDIUM

- **M1 — A Home timezone change silently loses the pending reminders.** `deliver_pet_care_reminder` (`:1408`) recomputes the moment in the Home's current zone and answers `stale` when it moved, but nothing requeues the new moment (no hook on `homes.timezone`; the hourly job only creates new occurrences). Up to 7 days of reminders for existing occurrences are dropped after a timezone change, which the spec names explicitly ("Handle changes in time zone"). Remediation: when the moment is stale and the occurrence is still open, call `private.schedule_pet_care_reminder(occurrence)` before returning `stale` (idempotent by key and only for future moments). Add a test.
- **M2 — No DST or timezone tests for care.** Nothing in the DB, route, component or jobs tests covers a reminder or status around a DST gap/overlap, the 08:00 default on a transition day, or a non-UTC Home vs UTC session. CLAUDE.md (date/time strategy) and the spec ("daylight-saving transitions") require them. The implementation relies on `(date + time) at time zone zone`, which is correct for gaps and overlaps, but that is untested. Note also that "1 day before" is `make_interval(mins => 1440)` (`:328`), so across a DST change it fires at 07:00 or 09:00 local, not at the same wall-clock time. Either accept this and document it, or use `(due_on - 1) + time` in the zone. Add vectors (e.g. Europe/Brussels, 2027-03-28 02:30 and 2026-10-25 02:30).

### LOW

- **L1** — The widget does not always put overdue first: it orders by `due_on, at_time nulls first` (`:842`), so an untimed "due" item today sorts before today's 07:00 item, which is overdue. With a low count limit that overdue row can be cut. The brief says "overdue … always shown first". Order by `status = 'overdue' desc` first.
- **L2** — Two advancers can deadlock: `advance_pet_care_home`/`advance_all_pet_care` lock up to 200 activities in `next_date` order (`:458`, `:461`, `:485`), and two transactions can see different `next_date` orders, which would surface as a 500 on a page read. Lock in `a.id` order.
- **L3** — A recorder without medical view cannot correct even the completion _time_ of a concealed occurrence (`:1309`; the domain mirrors it). The brief says the recorder may correct time or note. Consider allowing a time-only correction that keeps the note.
- **L4** — Reopening a skip: the database lets whoever skipped reopen (`skipped_by`), but the UI shows Reopen only for `recordedByMe` (completions) (`care-activity-view.tsx:287`), and `decidePetCareAction("care.reopen")` only knows `recordedBySelf`. Align the three.
- **L5** — An occurrence moved "only this occurrence" beyond today+7 disappears from the activity page's open list (`:787`) until the horizon reaches it.
- **L6** — Restoring a pet from the trash back-fills up to 7 days of overdue care for the days it was trashed, because its activities' `next_date` is not reset. Restoring an activity does reset it ("no back-fill"), so the two are inconsistent.
- **L7** — The open overdue occurrences of an _ended_ activity stay "overdue" forever on its page (`pet_care_status` only special-cases `paused`), and Done stays offered.
- **L8** — Unchecked cast `body.time as string` for a nullable value (`pet-care-occurrences/[occurrenceId]/route.ts:63`), against the CLAUDE.md "avoid unchecked casts". Type the parameter (or wrap it as in `readHomeCare`) instead.
- **L9** — No multi-connection concurrency test for care (other modules have `*-concurrency.test.ts`). The uniqueness constraint `(activity_id, scheduled_on)` and row locks make duplication unlikely, but "concurrent completion" and parallel advance are only simulated sequentially.

### Explicit checks

- **Requirements vs brief:** model, limits, categories, medication ⇒ medical, reminder offsets, state machine, parts/split, detached occurrences, statuses, events, widget settings, vacation counts, API and pages all match. Exceptions: H1 (series edit gap), L1 (overdue first), L3/L4 (correct/reopen rules).
- **Cross-Home isolation:** every public function resolves the Home from the row and rechecks `pet_access` or `require_pet_home`. Responsible members are validated as membership ids of that Home. A forged or other-Home id answers `not_found`/null, and another Home's widget answers 42501 (→ 404). DB-tested. OK.
- **Permissions:** create/edit/delete need pet manage plus medical manage when the activity has (or gets) medical details. Pause/resume/end/change-one need pet manage. Skip needs a responsible member or manager. Reopen needs the recorder or a manager. Correct needs the recorder or a manager, and not concealed. Complete is open to any member. Checked in the DB, mirrored in the domain engine, and the UI follows the DB flags. OK, apart from L3/L4.
- **Concealment:** title, instructions and notes are null for readers without medical view in `pet_care_activity_json`, `pet_care_occurrence_json`, the widget, and `pet_care_notice_names`. Reminder notices carry ids plus `dueDate` only, and emails carry no title. Audit details hold ids and flags only (DB-tested). A medical activity's trash entry, whose label is the title, is visible only with pet plus medical manage (DB-tested). The page title is neutral, and aria-labels use the category when concealed. Errors are not_found/not_permitted with no text. OK.
- **Input validation:** Zod (strict) at the routes, and the database revalidates everything (22023 → 400). Time HH:MM, weekdays, interval 1–99, date windows, note ≤500 plain text, members ≤10 distinct, completion time ≤ now+1 min and ≥ −366 days. OK.
- **Timezone/DST:** Home today/now and moments are computed in the Home zone in the database, and corrections convert in the Home zone. Untested (M2), and a timezone change loses reminders (M1).
- **Job idempotency and recheck:** the outbox key covers occurrence plus moment, and enqueue is `on conflict do nothing`. Delivery locks activity then occurrence and rechecks trash, moment, reminder setting, open, active, lateness (30 min) and current responsible members. `notify_user` is deduplicated per person plus moment. `not_due` retries (5 attempts). OK.
- **Occurrence races/uniqueness:** `unique (activity_id, scheduled_on)` plus `on conflict do nothing` and per-activity `for update`. Retry of create answers `exists`. A repeated completion by the same person answers `completed`, and by another person answers `closed`. OK (L2, L9).
- **Migration safety and grants:** additive tables with RLS enabled and all table privileges revoked. Every function has `set search_path = ''` and schema-qualified references. Public API functions are granted to `authenticated` only; job functions and `deliver_vacation_reminder` to `service_role` only; private helpers revoked. Trash dispatch wrappers are renamed `*_before_pet_care` and delegate. Constraint swaps on `audit_events`/`trash_entries` are supersets. Forward-only; the docs block is identical. OK.
- **Test coverage:** good multi-actor DB coverage (concealment, revocation, widget filters, complete/correct/reopen/skip, split, pause/resume/end, reminders, vacation counts, trash, departed members, pet deletion). Route, component (axe) and jobs tests exist, and Playwright covers the journey and concealment. Gaps: H1, M1, M2, L9.
- **Accessibility:** action buttons have descriptive accessible names. Forms use labels, legends and fieldsets, and focus moves to the first error. axe checks run in component tests and Playwright. Status is shown as text, not colour only. OK.
- **Performance:** reads advance lazily, bounded at 200 activities and 60 occurrences per activity per call. The hourly job is bounded at 200 activities. Partial indexes cover open occurrences and due parts. `advance_all_pet_care` computes `pet_today` per row, a full scan of active activities each hour, which is acceptable for MVP. Each widget render takes row locks (L2).
- **Maintainability:** follows the chores/habits/goals patterns, with limits mirrored between `PET_CARE_LIMITS` and `pet_care_limit`, and the docs and ADR updated. `decidePetCareAction` is tested but not used by the app (the UI uses the database's flags). That is acceptable but can drift (L4).

### Remaining risks and test gaps

- H1 until fixed: series edits with a far `from` silently lose care, including medication.
- Reminders after a Home timezone change (M1), and DST behaviour of moments and "1 day before" (M2).
- No real-concurrency test (L9). Quiet hours and preferences for `pet_care.reminder` rely on `notify_user` without a care-specific test.
- Household Display rendering of the widget is out of scope (S43–S44) and must apply the same concealment.

### Implementer follow-up to the care review (not re-reviewed, per the one-review rule)

- **H1 fixed.** A schedule change keeps the old part's `next_date` (cleared only when it is past the split), and `advance_pet_care_activity` and `advance_pet_care_home` advance every part that still has dates, so the old rule keeps creating its dates up to the day before the split. Pause/end/resume and restore now apply to every part (`private.rewind_pet_care_parts`; end clears all parts). `vacation_pet_care` counts an activity when any part has a date in the period (unassigned when none of those parts has members). New DB test: a daily activity changed "from day 20" gets days 8 and 19 once advanced to day 12, the new rule takes over on day 20 exactly once, and a vacation on days 15–16 counts it.
- **M1 fixed.** `deliver_pet_care_reminder` queues the current moment (idempotent by key, future moments only) before answering `stale`. DB test: an occurrence moved without queuing gets its new moment queued at delivery.
- **M2 fixed.** "1 day before" is the same wall-clock time the day before in the Home's zone. DB tests in Europe/Brussels across 2027-03-28: 1 day before 08:00 on 29 March is 08:00 on 28 March; without a time, 1 hour before is 05:00 UTC.
- Reruns: full DB suite 32 files / 152 tests green (types unchanged by the fix); Playwright `pet-care.spec.ts` and `pets.spec.ts` 3 passed. `docs/production-migrations.md` consolidated block refreshed.
- **LOW L1–L9:** not changed in this step.

### Owner decisions (Ward, 2026-11-04)

- **M1 (profile review):** restoring or purging a deleted pet needs medical _manage_ as well as pet manage. Implemented for every pet (`can_see_trash_entry`), so the rule reveals nothing about medical records; `tests/db/rls/pets.test.sql` asserts that a pet manager without medical manage neither sees, restores nor purges a pet's trash entry.
- **M3 (profile review):** revocation taking effect on the member's next request is accepted as is.
