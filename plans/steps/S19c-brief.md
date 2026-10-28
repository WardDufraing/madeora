# S19c · Tasks: attachments, calendar views and widgets — feature brief

**Branch:** `feat/task-attachments-calendar-widgets`, from `main` at `6a6678b` (S19b merged as PR #31; S15 storage, S16 trash and S17 dashboard merged earlier).
**Sources:** build plan S19c; PS L2239–L2246 (task document and image attachments), L2295–L2300 (deletion and recovery of parent items with attachments), L2126–L2133 (optional task calendar views), L2176–L2184 (configurable task dashboard widgets), L427 (starter dashboard includes personal tasks), L2149 (no dependencies), L2163 / L2206 (moves keep attachments); ARCH §10, §15, §36, §37 and L243 (per-feature file limits come from the owner); ADR 0019–0024. No other spec ranges read.
**Model:** Opus (file access across contexts, quotas, trash lifecycle and recurrence scopes).

**Done when:** attachment access tests and widget tests pass.

## Gate (asked on 20 Oct, decision card)

Attachment formats and limits are not in the spec, and architecture.md says not to invent them. Recommended and built meanwhile: images (JPEG, PNG, WebP) plus PDF, TXT, CSV, Word, Excel, PowerPoint and OpenDocument; up to 10 MB per file and 10 per task. No free malware scanner fits the €0 budget, so safety is an allowlist plus a real signature check (below). If Ward picks "Images + PDF only", the allowlist shrinks; if "Split attachments out", part 3 moves to its own step.

## 1. Task widgets (spec "Confirmed configurable task dashboard widgets")

- New widget type **`tasks`** in the S17 registry, on the personal dashboard (Personal tasks), on a Home dashboard (that Home's tasks) and on the personal dashboard bound to one Home (`home-source`, title names the Home).
- **Settings:** source list (one list, or All Tasks), status (open / completed / all), timing (any, overdue, due today, due in the next 7 days, starts later, no due date), priority (any of, incl. unspecified), labels (any of), assignee (Home only: anyone, me, unassigned, a member), how many rows (5 / 10 / 15). Each widget has its own settings; ids of lists, labels and members are checked again at render.
- **Display:** title, list name (All Tasks), due/start, priority, assignees, subtask progress, recurring badge, as text; a header line naming the list and active filters; Clear-filters hint in the empty state; "Open all tasks" link to the full list with the same filters.
- **Complete / reopen** from the widget with the task-level permission the database reports per row (`can_complete`), the same confirmation for unfinished subtasks, one shared completion (already-completed names the completer), per-occurrence completion for recurring tasks. No bulk edits, drag and drop or editing in widgets.
- **Safe states:** a deleted or archived source list shows "This list is no longer available" (never another list); a deleted label or departed member in the settings is ignored and says so; a Home the viewer left shows the S17 neutral unavailable state; a failed read shows the widget error. Data comes from `list_tasks` with the viewer's session, so nothing is cached across people.
- **Starter:** the personal starter layout gains a Personal tasks widget (spec L427); saved dashboards are untouched.

## 2. Task calendar view (spec "Confirmed optional task calendar views")

- `…/tasks/calendar` (personal and Home), reached by a **List / Calendar** switch on the tasks page; lists stay the default and nothing requires the calendar.
- **Week** and **month**, with previous / today / next, in the context's timezone (Home timezone; the person's for Personal). Filters: list, status, priority, labels, assignee (same meanings as lists).
- Tasks appear on their **due date**: open, completed, overdue and recurring are labelled in text. A task with a start date shows "starts" on that day as well, never a duration. **Planned** future occurrences of active recurring series are shown on their dates from the series rule (not yet created, marked "planned", opening the series' current task). Tasks without a due date are not placed; a line says how many there are and links to the list filter "No due date".
- **Selecting a day** shows its tasks with details, complete/reopen (same rules as lists) and a link to the full task (edit there).
- One database function returns the window (at most 42 days, at most 500 entries, `truncated` flag) with the viewer's session: Home membership, list visibility and deleted/archived lists apply per entry.
- The main Calendar's "Show tasks" overlay belongs to the Calendar module (later step); not built here.

## 3. Task attachments (spec "Confirmed task document and image attachments")

**Rights (inherit the task):** everyone who can see the task sees its attachments and downloads them; the task's editors (S18: creator, assignees, task managers) upload and remove. Series-wide changes (following / entire series) need the S19 series right. Rechecked on every call, including downloads.

**Upload flow (S15 pipeline, new purpose `task_attachment`):**

1. `create_task_attachment_intent(task, type, size, name, request_id)`: task editable and not deleted, type and size allowed, at most 10 attachments (counting uploads in progress) per task, the **task's pool** (Personal pool for a Personal task, the Home's pool for a Home task), same rate limits and locking as S15; the safe display name is stored with the pending upload.
2. Browser PUTs to the presigned URL (bound type and size).
3. Finalize (server): claim, HEAD, read back at most 10 MB, size/type must equal the intent, **signature check** (JPEG/PNG/WebP magic bytes; PDF `%PDF-`; Office/OpenDocument: a ZIP whose entries include `[Content_Types].xml` or the right `mimetype`; TXT/CSV: valid UTF-8 without NUL bytes). Images are decoded with the S15 pixel limits (50 megapixels) and **re-encoded in the same format with all metadata removed** (location, camera); other files are stored as uploaded. Then `finalize_upload` (service role, unchanged rules) and, with the person's session, `attach_task_file(file, scope)`, which rechecks the task and rights at that moment. A ready file that never got attached is retired by the existing expiry job, so a failed or abandoned upload never shows as saved and never counts forever. A retry with the same request id reuses the same upload (no duplicates).
4. **Downloads:** `GET /api/v1/files/{id}/content` authorizes every request (`authorize_file_read` extended: an attachment is readable while it is linked to a task the viewer may see now), then 302 to a 60-second link. Images are shown inline in the task page as previews; PDFs open in the browser from the storage domain; everything else downloads with its display name. `Cache-Control: private, no-store`.

**Removal and recovery:** removing an attachment puts it in the task context's trash (item type `task_attachment`, 7 days, the S16 rules), with the file still counted; restoring brings it back unless the task is gone or in the trash (`task_unavailable`), or the task already has 10 (`attachment_limit`). Deleting a task takes its exclusively attached files into the trash with it and restores them together; a file still used by another task (series copies) stays. Purging releases a file only when nothing references it any more. Moves keep attachments (same context).

**Recurring tasks (scopes, S19 pattern):** attachments are either **this occurrence's** or **from the series**, labelled so. Adding or removing on an occurrence asks the scope: this occurrence, this and following, entire series. Series attachments live on the chain (like the S19b reminder template); new occurrences get them; "following" and "entire" also apply to open, not individually changed occurrences from that date or all; completed ones are never touched. A dry-run preview shows the impact. A series-wide removal is one trash entry (`task_series_attachment`) that brings the series attachment and the occurrence links back together.

**Interface:** an Attachments section on the task page: list with name, type, size, "from the series" marker, preview thumbnail for images (authorized URL), Download / Open, Remove (confirmation, scope dialog for occurrences); Add file with the allowed types and limits explained before choosing, progress, cancel, failure with retry, storage-full and storage-off messages; empty, uploading, failed and removed states; keyboard and screen-reader access. With storage off, the section says uploads are unavailable here.

**Not exposed anywhere else:** widgets, calendars, notifications, activity and trash labels show at most an attachment count or the display name to people who may see the task (the trash label is the display name, visible under the S16 trash rule).

## Permissions summary

| Action                                  | Who                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| See, preview, download attachments      | anyone who can see the task                                                      |
| Upload, remove (this task / occurrence) | task editors (creator, assignees, task managers)                                 |
| Series attachments (following / entire) | series creator, task managers                                                    |
| Restore a removed attachment            | the S16 trash rule (who removed it, Owner / `manageHomeSettings` Administrators) |
| Complete from widget or calendar        | per row `can_complete` (S18 edit rule)                                           |
| Configure widgets                       | who may edit that dashboard (S17)                                                |

## API

`POST /api/v1/tasks/:id/attachments/upload-intents`, `POST /api/v1/files/:id/finalize` (purpose-aware), `GET /api/v1/tasks/:id/attachments`, `DELETE /api/v1/task-attachments/:id` `{ scope, dryRun }`; calendar `GET /api/v1/tasks/calendar?homeId&from&to&…`; widgets render on the server.

## Tests

- **Database:** intent rules (editor only, deleted task, limit 10 incl. pending, type/size, pool per context, Home pool full, personal pool full); attach rechecks (left Home, lost assignee right, task deleted); authorize read across two Homes, former member, deleted task, removed attachment, forged id; remove → trash → restore (conflicts), task delete/restore with attachments, shared file stays, purge releases only unreferenced files, quota counted while in trash; series scopes this/following/entire with completed and detached kept, new occurrences inherit, series-wide removal round trip; calendar window, limits, projections, filters, cross-Home; `list_tasks` new timing filters.
- **Concurrency (two connections):** two intents racing for the 10th slot; concurrent removal of the same attachment.
- **Unit:** signature checks (renamed executable as PDF, ZIP without Office entries, NUL in TXT, truncated image, pixel bomb), image metadata stripped, display-name sanitizing, routes (CSRF, unauthenticated, invalid, storage off, outcomes), widget settings schema and reader, widget content (filters, safe states, complete), calendar grid (weeks, DST boundary, month edges), components with axe.
- **Playwright:** attach an image and a PDF (S3 stand-in), preview and download; a member of another Home gets 404 on the content URL; remove and restore from trash; add a tasks widget with filters and complete from it; calendar month/week navigation and complete from a day; keyboard and axe in both themes.

## Out of scope

Main Calendar "Show tasks" overlay (Calendar module), wall-display presentation (Household Display steps), attachment folders, annotations, versions, reusable file libraries (spec excludes), malware scanning service (none free), Realtime (views refetch after changes), copying attachments into templates (spec excludes).

## Defaults picked (Ward may override)

1. Formats and limits as in the gate above (pending Ward's card).
2. Editors upload and remove; viewers download.
3. Images keep their format but lose all metadata; nothing else is converted.
4. Removed attachments go to the trash for 7 days (the S16 rule).
5. Widget rows: 5, 10 or 15; timing states as listed; personal starter gets a Personal tasks widget.
6. Calendar: week and month, planned occurrences shown, 42-day window cap.

## Progress

- [x] Widgets - [x] Calendar - [x] Attachments - [x] Full suite (logs: wip/S19c) - [x] Review (round 1 CHANGES_REQUIRED, fixed; round 2 PASS: reviews/steps/S19c-review.md) - [ ] Commit, push, PR (waiting for Ward)
- Owner decision 20 Oct: images + common documents, 10 MB per file, 10 per task.
- Follow-ups from review round 2 (non-blocking): restoring a series attachment can exceed the 10-per-chain cap (MEDIUM-A); retry during a running finalize discards the attempt (LOW-A).
