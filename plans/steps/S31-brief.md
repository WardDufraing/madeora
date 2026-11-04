# S31 · Pets: profiles, medical history and medical access — feature brief

**Branch:** `feat/pets`, from `main` at `a06039c` (S30c merged as PR #58).
**Sources (read only these):** build plan S31; Modules.md §4.6 and its four confirmed decisions (L73–L112: profile scope and optional fields, structured medical history, care schedules, medical-information access permissions); PS L1864–L1866, L1885, L1925 (vacations keep pet care active), L2462, L2498; ADR 0011, 0014 (permission engine, capabilities), 0019, 0020, 0025 (file storage, trash, attachments).
**Model:** Opus (thread verdict 4 Nov 2026: a new sensitive permission category, RLS and leak-proof concealment, private attachments).
**Done when (build plan):** the "Pet care" journey passes and medical info is hidden from members without permission.
**Sources for the care part:** Modules.md §4.6 "Confirmed dedicated pet care schedules" and the concealment rule in "medical-information access permissions"; PS L1885, L1925 (vacation reminder surfaces pet care; vacations never pause it).

## Scope (Ward kept one step, 4 Nov 2026)

Ward rejected the proposed split: S31 covers pet profiles, sensitive details, medical history with attachments, the medical access permission, trash and audit, **and** pet care (care schedules, reminders, the separate pet-care widget, pet care in the vacation reminder). Done when: the "Pet profile and medical history" and "Pet care" journeys pass, and medical information (medication details included) is hidden from members without permission in pages, the widget and notifications (RLS and interface tests).

## Permission matrix (proposed default; the spec asks for it to be documented before implementation)

| Action                                                                                                                   | Owner | Administrator                                                 | Member                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------- | -------------------------------------- |
| See pets and basic profile (name, photo, species, breed, birth/age, weight, vet contact, diet, care instructions, notes) | yes   | yes                                                           | yes                                    |
| Add, edit, delete and restore pets and basic profile                                                                     | yes   | with new capability `manageHomePets`                          | no                                     |
| See sensitive details (allergies, medications, identification, medical notes), medical history and its attachments       | yes   | with medical access _view_ or _manage_                        | with medical access _view_ or _manage_ |
| Add, edit, delete and restore medical entries, attachments and sensitive details                                         | yes   | with medical access _manage_                                  | with medical access _manage_           |
| Grant or revoke medical access                                                                                           | yes   | with new capability `managePetMedicalAccess`, never their own | no                                     |

- **Medical access** is a per-member, per-Home level: _none_ (default for everyone but the Owner), _view_, or _manage_. It is a category-level permission, not per pet, entry or field. A new member, a new Administrator and a newly granted `manageHomePets` all start with _none_. Changes are audited and effective on the next read: every read, download link and mutation rechecks it. Leaving or removal deletes the grant; rejoining starts at _none_. An ownership transfer makes the new Owner implicit _manage_; the former Owner keeps no implicit access (an explicit grant may be added).
- Pet-module access itself is every current member (no module visibility setting exists yet).

## Model

- **Pet** (`private.pets`): Home-owned (no personal pets). Only **name** (1–80) is required. Optional: species (preset dog, cat, rabbit, guinea pig, hamster, bird, fish, reptile, horse, other with a custom label), breed (≤120), birth date (not in the future) **or** an approximate age in years and months with the date it was recorded (shown as "about 3 years, as of …"; never turned into a birthday), sex (female, male) and neutered (yes/no), weight (0.001–2000, kg, g or lb, up to 3 decimals, with optional recorded date), veterinarian (name, clinic, phone, email, address), diet, care instructions, notes (≤2000 each), photo (one image).
- **Unknown vs not entered:** species, breed, birth/age, sex, neutered, weight, diet and every sensitive field can be _not entered_ (empty), a value, or explicitly **Unknown**; allergies and medications can also be explicitly **None**. Empty is never shown or treated as None.
- **Sensitive details** (`private.pet_medical_details`, one row per pet): allergies, medications, identification (microchip number, registration or passport number, other identification notes), medical notes. Kept in their own table so RLS hides them as a whole.
- **Medical history** (`private.pet_medical_entries`): pet, **event date** and **event type** required (vet visit, vaccination, treatment, test or diagnosis, surgery, other); optional title (≤120), veterinarian, location, treatment details, notes, follow-up date (on or after the event date). Event dates from the pet's birth date (when known) or 1980-01-01, up to two years ahead. Entries dated after the Home's today show as **Upcoming appointments**, apart from the history timeline (newest first). Edit is a correction in place with a revision check (`stale`). No reminders, regimes or vaccination expiry are derived (spec).
- **Attachments** (`private.pet_medical_attachments`): the S15/S19c upload pipeline with a new purpose `pet_medical`: JPEG, PNG, WebP and PDF only (invoices, certificates), 10 MB per file, 10 per entry, counted in the Home's storage pool; images re-encoded without metadata. Upload failure is shown and nothing is claimed saved before finalize. Download needs medical view at the moment of the request (60-second link, `authorize_file_read`).
- **Photo:** one image per pet through the same pipeline, purpose `pet_photo` (JPEG, PNG, WebP, 10 MB), visible to every member.
- **Limits:** 50 pets per Home, 1000 medical entries per pet, 10 attachments per entry.

## Care schedules (the former S31b part)

- **Activity** (`private.pet_care_activities`): one pet; **title** (1–120) required; **category** feeding, medication, grooming, vet appointment or other (default other); optional instructions (≤2000); **contains medical details** flag, always on for medication and optional for the rest; reminder setting (off, at the time, 15 minutes, 1 hour or 1 day before); state active, paused or ended. 100 activities per pet.
- **Schedule** (`private.pet_care_parts`, the chore "part" pattern): once (a date) or the S19 recurrence (daily, weekly on weekdays, monthly, yearly, every 1–99) from a start date with an optional end date; optional time of day (Home timezone); responsible members (0–10, current members; none means **Unassigned**, shown as such; nobody is assumed responsible). Editing the schedule "from this occurrence on" ends the current part the day before and starts a new one (history and completed occurrences stay); "only this occurrence" moves its date or time or changes its responsible members (detached, later series changes leave it alone). Title, category, instructions and reminder apply to the whole activity.
- **Occurrences** (`private.pet_care_occurrences`): created ahead up to 7 days (pages and the hourly job; one per activity and date, whatever retries or races do). Status: **Upcoming** (later), **Due** (today, time not passed), **Overdue** (open, date or time passed), **Completed** (who recorded it and when it was done), **Skipped**; the activity shows **Paused** or **Ended**. A missed occurrence stays open and overdue; nothing escalates. Completion is explicit; reminders and schedules never imply it. Corrections: the person who recorded it or a pet manager may change the completion time or note, or reopen; every completion, skip, reopen and correction is kept in `pet_care_events`.
- **Pause / resume / end:** pause removes open, untouched future occurrences and creates none until resumed; resume continues from today (no back-fill); end stops the schedule for good and removes open future occurrences. Deleting a pet or an activity takes its occurrences into the trash with it; a departed member's responsibility disappears (the occurrence shows Unassigned).
- **Permissions (Ward approved the matrix; care follows "ordinary pet-care schedules under pet-module permissions"):** every member sees activities and occurrences and may complete them; pet managers create, edit, pause, resume, end, delete and restore activities and may skip, correct or reopen any occurrence; a responsible member may skip their occurrence; whoever recorded a completion may correct or reopen it. An activity with medical details needs pet manage **and** medical _manage_ to create, edit or delete (its texts are medical information).
- **Concealment:** for anyone without medical view at that moment, an activity with medical details shows only its category ("Medication"), the pet, timing, status and responsible members: never its title, instructions or completion notes, in pages, the widget, notifications, the trash or errors.
- **Reminders** (optional, per activity): outbox job `pet-care-reminder` keyed by occurrence and revision, at the occurrence time minus the offset (08:00 Home time for occurrences without a time); delivery rechecks that the occurrence is still open, current and not paused, and notifies each responsible member still in the Home (category `reminders`, their preferences and quiet hours). In-app text names the pet and, only for readers with medical view or activities without medical details, the title; email never contains the title or instructions. Unassigned care is not reminded. Not sent for a moment already passed.
- **Widget** `pet-care` (Home dashboard and Home-sourced on the personal dashboard): settings pet (all or one), range (today, 3 days, 7 days; overdue from the last 7 days always shown first), who (everyone, me, unassigned) and count (5, 10, 15). Rows: pet, activity (concealed as above), time, status, responsible members; Complete button; links to the activity and the pet.
- **Vacation reminder:** the manager reminder before a vacation adds how many active pet-care activities have dates during the vacation and how many of those are unassigned; vacations never pause pet care (PS L1925).
- **API:** `GET/POST /api/v1/pets/:id/care` (list, create), `GET/PATCH/DELETE /api/v1/pet-care/:id` (activity, edit with scope), `POST /api/v1/pet-care/:id/state` (pause, resume, end), `POST /api/v1/pet-care-occurrences/:id` (complete, skip, reopen, correct, edit this occurrence), `GET /api/v1/pet-care?homeId=` (widget data).
- **Interface:** a Care section on the pet page (activities with their next occurrence and status, Add activity for managers) and an activity page (`/homes/[homeId]/pets/[petId]/care/[activityId]`) with schedule, upcoming and recent occurrences and their actions.

## Trash, deletion and audit

- Deleting a pet is one 7-day trash entry that takes its sensitive details, medical entries and attachments with it; restore brings everything back with the same protection. Delete needs pet manage; restore and early purge need medical manage too.
- A pet's trash entry is visible to, and restorable or purgeable by, people with pet manage **and** medical _manage_, for every pet (Ward, 4 Nov 2026, M1); restore needs room under the pet limit (`pet_limit`). Revoking medical access takes effect on the member's next request (Ward accepted, M3).
- Deleting a medical entry or removing an attachment is its own trash entry; it is visible in the trash, and restorable, only for people with medical _manage_ at that moment (anyone else, medical viewers included, does not see it, not even its type or count). Restore refuses while the pet (`pet_in_trash`) or, for an attachment, its entry (`entry_in_trash`) is in the trash, and at the limits (`entry_limit`, `pet_attachment_limit`). Purging a pet or an entry purges its open child entries.
- Home audit events with ids and levels only (no names of medicines, titles or notes): `pet.created`, `pet.updated`, `pet.deleted`, `pet.restored`, `pet.medical_details.updated`, `pet.medical_entry.created|updated|deleted|restored`, `pet.medical_attachment.added|removed|restored`, `pet.medical_access.changed`.

## Leak rules

A person without medical view never receives: sensitive fields, medical entries, their count, existence, dates or types, attachment names, thumbnails or file ids, medical trash entries, or a different error. The pet list and profile show no "has medical records" hint. Errors for a forged medical entry id are the same `not_found` as a missing one.

## Interface

- **Home nav:** Pets (`/homes/[homeId]/pets`): cards with photo, name, species and age; Add pet (name only, then the profile).
- **Pet profile** (`/homes/[homeId]/pets/[petId]`): basic sections (Identity, Health basics: weight; Veterinarian; Diet and care; Notes) with Unknown / None controls; **Medical** section only for medical viewers: sensitive details, Upcoming appointments, History timeline, Add entry (managers); entry detail and edit page with attachments.
- **Member management** (`/homes/[homeId]/members/...`): a "Pet medical information" control (No access · View · View and edit) for whoever may grant it; new capability toggles for `manageHomePets` and `managePetMedicalAccess` with the existing capability UI.
- nl and en strings; accessible forms (React Hook Form + Zod), keyboard and axe tests.

## API

`GET/POST /api/v1/pets?homeId=`, `GET/PATCH/DELETE /api/v1/pets/:id`, `GET/PUT /api/v1/pets/:id/medical`, `POST /api/v1/pets/:id/medical-entries`, `GET/PATCH/DELETE /api/v1/pet-medical-entries/:id`, `POST /api/v1/pet-medical-entries/:id/attachments` (intent; finalize is the shared `POST /api/v1/files/:id/finalize`), `DELETE /api/v1/pet-medical-attachments/:id`, `POST/DELETE /api/v1/pets/:id/photo`, `GET/PUT /api/v1/homes/:homeId/pet-medical-access` (by membership id). Same CSRF, JSON, size, session and outcome mapping as the goal routes.

## Database (`20261116090000_pets.sql`)

Tables above plus `private.pet_medical_access`; capabilities `manageHomePets`, `managePetMedicalAccess`; `private.pet_access(home, user)` and `private.pet_medical_access_level(home, user)`; security-definer functions for every read and write (no table grants); trash item types `pet`, `pet_medical_entry`, `pet_medical_attachment`; `authorize_file_read` and the upload purposes extended.

## Tests

- **Database (RLS, multi-actor):** name-only pet; field validation (future birth date, weight range and unit, email, follow-up before event); unknown vs none vs empty round-trip; member sees basics but not details/entries/attachments/trash entries/counts; medical viewer reads but cannot write; medical manager writes only in their Home; Administrator with `manageHomePets` but no medical access; grant and revoke take effect on the next call (file read authorization included); grantor rules (Member cannot grant, Administrator without capability cannot, Administrator cannot change their own); removal and rejoin reset to none; ownership transfer; cross-Home and forged ids; pet delete/restore with medical data; entry delete/restore requires medical manage and hides from non-medical trash viewers; attachment limits and file read authorization; stale revision.
- **Unit:** schemas, permission engine matrix, routes, components with axe.
- **Playwright ("Pet profile and medical history"):** Owner creates a pet with only its name, fills part of the profile, marks allergies None and breed Unknown, adds a vaccination entry with a PDF and a future vet visit (Upcoming), grants a Member medical view; that Member sees the entry but no edit controls; revoking hides it on reload; a Member without access sees the profile without any medical section.

## Out of scope (this step)

Household Display rendering (S43–S44; must apply the same leak rules), Ora, exports, search, Photos module integration (S35), child accounts (S41), per-pet or per-field sharing (excluded by the spec), health analytics and automatic regimes (excluded by the spec).

## Defaults picked (Ward may override)

1. ~~Split S31 / S31b~~ (Ward kept one step).
2. Permission matrix above: pets managed by the Owner and Administrators with `manageHomePets`; medical access a separate per-member level granted by the Owner or Administrators with `managePetMedicalAccess`.
3. Sensitive = allergies, medications, identification, medical notes, medical history and attachments; weight, diet, vet contact and care instructions are basic.
4. Attachment formats JPEG/PNG/WebP/PDF, 10 MB, 10 per entry.
5. Deleting a pet takes its medical data and care activities into the same trash entry.
6. Care: occurrences 7 days ahead; edit scopes "only this occurrence" and "from this occurrence on"; any member may complete; activities with medical details need medical manage to edit; reminder offsets as above with 08:00 for untimed care; the vacation reminder shows counts only.

## Progress

- [x] Brief
- [x] Migration
- [x] Database tests
- [x] API and data layer
- [x] Interface
- [x] Unit, route and component tests
- [x] Playwright
- [x] Docs (ADR 0041, user stories, supabase-migrations, production-migrations, roadmap)
- [x] Full suite
- [x] Independent review of the profile/medical part (CHANGES_REQUIRED: H1 fixed after review; M1 and M3 need Ward)
- [x] Care: migration, database tests, API, jobs, widget, vacation reminder, interface, tests, Playwright, docs (ADR 0041, development, supabase-migrations, production-migrations, user stories US-035)
- [x] Full suite and independent review of the care part (CHANGES_REQUIRED: H1, M1, M2 fixed after review; LOWs open)
