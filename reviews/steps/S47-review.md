# S47 independent review: Ora guided changes, Quick Undo, suggestions, daily teaser

Branch feat/ora-actions-undo. Reviewed: S47.diff, migration, DB test, server/routes/tool registry, client components. Nothing was run; the DB test was reasoned about.

## Verdict: CHANGES_REQUIRED

1 BLOCKER, 1 HIGH, 4 MEDIUM, 4 LOW.

## Findings

### BLOCKER-1: dismissing a suggestion always fails in the real database (missing column grant)
- supabase/migrations/20261207090000_ora_suggestions.sql:47-52 versus apps/web/src/ora/suggestions/server.ts:63-72.
- The table grants INSERT and UPDATE only on (user_id, scope, home_id, kind, situation). `dismissSuggestion` upserts a payload that also contains `dismissed_at`. Postgres needs a column privilege for every column named in an INSERT or in the ON CONFLICT SET list. The call is therefore refused with 42501 (permission denied for column dismissed_at). The server maps 42501 to "forbidden" and the route answers 403.
- Impact: Dismiss never persists, in the panel or on the teaser. The teaser's dismiss swallows the error silently. The panel shows "dismissFailed". "Dismissed suggestions stay suppressed" is therefore not met. The DB test inserts without `dismissed_at`, and the TS tests mock Supabase, so nothing catches it.
- Remediation: either drop `dismissed_at` from the upsert payload and set it in the DB, or grant insert and update on `dismissed_at`. A trigger or a column default that refreshes it on update is the more tolerant choice. Add a DB test that performs the exact upsert the app sends (onConflict user_id,scope,kind with all payload columns). Both the INSERT and the DO UPDATE branch need to be covered.

### HIGH-1: Undo checks the revision in a separate read, so it can still overwrite a concurrent edit
- apps/web/src/ora/actions/server.ts:63-95 (undoAction).
- `getTask` or `getShoppingList` reads the revision. A separate `delete_task` or `delete_shopping_item` call then trashes the record. Neither RPC takes an expected revision. If anyone edits the record between the read and the RPC, Undo trashes the record, including their change. That is the exact guarantee in the ADR and brief: "anyone's later edit blocks it".
- Impact: low probability but real, and the guarantee is advertised. The data lands in Trash, so it is recoverable.
- Remediation: do the revision and window check inside the transaction, either as a new reviewed RPC (for example `undo_ora_created_task(p_id, p_expected_revision, p_window)` that locks the row) or by adding an optional expected-revision parameter to the delete RPCs. If that is deferred to S47b, record it in the ADR as a known limitation and weaken the wording of the claim.

### MEDIUM-1: focus is lost on view changes (accessibility)
- apps/web/src/components/ora/ora-action.tsx:217-290 (done view, form submit) and the quick-action path in ora-content.tsx (`setView("action")`).
- Pressing the confirm button unmounts the form, and the focused element disappears. The result `<p role="status">` is announced, but focus drops to `<body>`, which sits outside the Ora surface and its focus handling. Entering the action view from the main view unmounts the pressed button in the same way.
- Likewise, a failed validation sets `fieldError` but does not move focus to the field. The same happens when "Add anyway" (inside the role=alert block) is pressed: `update()` clears the failure, so the focused button and the alert disappear.
- Remediation: move focus to the view heading or the status message on view change and on done. Focus the invalid field on a failed submit. After "Add anyway", move focus to the confirm button. Add a test that asserts `document.activeElement`.

### MEDIUM-2: the dismiss button in the suggestion list also drops focus
- ora-content.tsx suggestions list. After a successful dismiss the invalidated list removes the focused button. Inside a non-modal dialog or sheet this lets focus escape. Move focus to the next item or the greeting. `loading={dismiss.isPending}` also puts every row's button into the loading state at once. This is cosmetic only.

### MEDIUM-3: the DB test probably cannot pass as written (sole Owner leaves the Home)
- tests/db/rls/ora_suggestions.test.sql:138-146.
- Alice is the only member and the Owner of home-a. The test then deletes her membership. `home_memberships_owner_required` (20261016090000_homes.sql, deferred constraint trigger) raises 23514 at commit, because the Home still exists with no Owner. Other tests (ora_settings) delete a plain Member instead.
- Remediation: make Alice a Member in Bob's Home, as ora_settings.test.sql does. Dismiss there, remove her membership, and assert the cascade.

### MEDIUM-4: the teaser day can be consumed and never shown
- apps/web/src/components/ora/ora-teaser.tsx:28-37 and suggestions/server.ts claimTeaser.
- The claim is committed in the database before the response reaches the client. If the response is lost, or the person switches Home or Personal before it arrives, or the teaser was `hidden` because Ora is open and is then dropped by the `teaser.homeId !== homeId` check, the day's single teaser is used and nothing was shown. The cost is one missed teaser per day. It does not break the "at most one" rule.
- Also, `situation` is the local date of the place that was asked. Two Homes in far-apart time zones can produce a date that runs ahead of the other, which then suppresses the next claim by a day (the DB check is monotone). This is acceptable but should be documented.
- Remediation: either accept and document it, or have the client re-attempt only after a network error. Do not claim the day when the surface is open.

### LOW-1: dismissal `situation` is arbitrary client text
- apps/web/src/ora/suggestions/types.ts (`z.string().min(1).max(64)`) and the DB check allow any 1 to 64 character string. A person can pre-dismiss a future date (or any string) for themselves. It is self-only and harmless, but validate it as a `YYYY-MM-DD` date for the `today-overview` kind, in both Zod and a DB check.

### LOW-2: no owner-guard trigger on ora_dismissed_suggestions
- The migration lacks the equivalent of `keep_ora_home_palette_owner`. RLS WITH CHECK holds, so a person can only move their own row between their own scopes. A PK collision would surface as a 23505, mapped to "failed". Harmless, but inconsistent with S45. Either narrow the UPDATE grant to (situation, dismissed_at) or add the trigger.

### LOW-3: Undo is not bound to the author
- Anyone permitted to delete the record, who knows its id and revision, can "undo" within five minutes. This is not an escalation, since the delete RPC enforces `can_delete_task` and `delete_shopping_item` has its own rules. Recording `created_by` or an Ora action marker is out of scope. Mention it in the ADR.

### LOW-4: confirm in flight while the Home switches or Ora is re-keyed
- ora-action.tsx `confirm()`. `OraContent` is keyed by place, so a Home switch unmounts the form while the request is still running. The result (including the Undo toast) is then lost for that change. The record is created with no feedback. Rare; document it, or show the toast through a place-independent path.

## Explicit checks

- Requirements: the "Ora change" journey is covered by the component tests (preview, named confirm button, retry, Undo, truthful refusals, in-memory draft). Not met until BLOCKER-1 is fixed: "dismissed suggestions stay suppressed". One teaser per day and the personal mute are enforced in the database and look right.
- Cross-Home isolation: pass. The context is resolved server-side and membership-checked for each call. Undo compares `homeId` with the resolved context. Suggestions come from existing session-scoped reads. The dismissal table is keyed by membership, with a composite FK to `home_memberships_all`, cascade on leave, RLS requiring current membership, and a scope/home_id consistency check. A personal row (home_id NULL) is skipped by the MATCH SIMPLE FK as intended.
- Permissions: the tool catalogue gates the action (`home.tasks.create`, `home.shopping.create`). The actual write goes through the module APIs and RPCs, which re-check the person's rights. Undo is checked again by `can_delete_*`. `prepare` only offers editable lists. No privilege escalation found. The security-definer claim function pins `search_path`, is revoked from public and anon, uses `auth.uid()`, and bounds the date to within 1 day of UTC. A forged future date cannot buy extra teasers (the update is monotone). The grants on `last_teaser_on` are correctly absent for authenticated.
- Secrets: none added.
- Input validation: the routes are strict Zod, with JSON/CSRF checks (`checkJsonMutation`), body-size caps and `no-store`. `situation` is weak (LOW-1).
- Migration safety: additive only (two columns with defaults, one table, one function). Rollback is a drop. The timestamp sorts after 20261206. Types are updated. The grant gap is BLOCKER-1.
- Test coverage: server and route tests are thorough on paths but mock Supabase. The DB test misses the real upsert (BLOCKER-1) and likely fails at the sole-Owner delete (MEDIUM-3). There is no concurrency test for Undo (HIGH-1).
- Accessibility: labels, roles, axe on the main surface, reduced layout via existing components. Focus management is lacking (MEDIUM-1, MEDIUM-2). The teaser is `role=status` and non-modal, which is good.
- Performance: one extra overview read per Ora open and per teaser claim. Both are gated by `active` and the once-per-day claim. Acceptable.
- Maintainability: clean separation (types / client / server), the action ids are a closed catalogue, and the comments explain the rules. The 42501-to-"forbidden" mapping hid BLOCKER-1; consider logging the code.

## Remaining risks and test gaps

- No DB test for the app's exact upsert, the column-grant surface, or `claim_ora_teaser` under concurrent calls (two sessions, same date). Add a two-connection test, or at least a sequential test with the app payload.
- No test that Undo refuses after a concurrent edit (HIGH-1), nor `activeElement` assertions after confirm, failure and dismiss.
- No test for the toast Undo path when Ora is closed.
- The e2e/Playwright coverage of the journey was not run locally by design; CI must run it.
- The 5-minute Undo window is a default pending the owner's decision (brief default 2).

## Fix notes (implementing thread, verified once, no second review round)
- BLOCKER-1 fixed: `dismissed_at` added to the insert/update grants; the DB test now runs the app's exact upsert.
- HIGH-1: accepted and recorded as a known limitation in ADR 0052 (the delete RPCs take no revision; a locking RPC is S47b). The record lands in Trash.
- MEDIUM-1/2 fixed: focus moves to the action view on open, result and failure, to the field on a validation error, and back to Ora's surface after a dismissal (test asserts it).
- MEDIUM-3 fixed: the DB test now has Alice as a Member of Bob's Home and leaves that one.
- MEDIUM-4, LOW-3, LOW-4: documented in the ADR. LOW-1 fixed (dismissal situation must be a date, in Zod and a DB check). LOW-2 left (RLS holds; harmless).
