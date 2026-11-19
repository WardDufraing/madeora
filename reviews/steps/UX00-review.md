# UX00 review — Dashboard UX/UI redesign plan (`plans/steps/UX00-redesign-plan-brief.md`)

Reviewer: independent architect agent, fresh context. Scope: docs-only plan on branch `docs/dashboard-redesign-plan`.
Read: plan, `docs/design/dashboard-ux-ui-redesign.md` (full), `docs/design/design-decisions.md`, `CLAUDE.md`, spec L2418–2422 and L3215–3290 only, `Modules.md` §4.1, §4.2, §4.9, `Project-entry.md` (grep for weather, notes and work schedule only). Spot-checked: `dashboard/{widgets,layout,geometry}.ts`, `dashboard-editor.tsx`, `displays/layout.ts`, `display-screen.tsx`, `display-lock-dialog.tsx`, `nav-items.ts`, `sidebar.tsx`, `task-view-switch.tsx`, `widget-preview.tsx`, `design-tokens/src/scale.ts`, and migrations `dashboards`, `display_layouts_lock`, `display_pin_no_lockout`, `user_preferences`, `tasks` and `privacy_exports`.

## Verdict: CHANGES_REQUIRED

The coverage is good: every number from 1 to 71 appears in the matrix, and Decision 72 is correctly kept out of scope. Most claims about the code are accurate. These were confirmed:

- No Notes module exists in the repo or in `Modules.md`.
- No work-schedule feature exists in the repo or in `Modules.md` §4.2.
- `sm` placements exist, fixed at `w=1`.
- The editor draft is only `useState(initial)`, and a `beforeunload` guard already exists.
- The display facts are right: 4 widget types, max 8, `IDLE_RESET_MS` 60 s at `display-screen.tsx` L30.
- The token comments and all the spec line citations are right.

Three HIGH findings block approval: one unflagged spec conflict, one unapproved service, and one privacy gap.

## Findings

### HIGH-1: Decision 37 (5-minute PIN unlock) conflicts with the built S44 rule and spec, but is not flagged

- Location: plan §3D row "37"; §2 (D2 list).
- Evidence:
  - `20261204090000_display_layouts_lock.sql` L15–17 quotes the spec: "privacy-mode unlock ... a Home manager must use an independently authorized session". It also says tapping or picking a member never unlocks.
  - `display-lock-dialog.tsx` L20–23 says the same: the PIN only locks, and "Nothing here unlocks".
  - No display-wide PIN exists. PINs are per-member household-device PINs.
  - Owner decision 2026-11-13 (`20261205090000_display_pin_no_lockout.sql` L1–5): display tries never count toward a member's PIN lock.
- Impact: the plan marks Decision 37 as "E, existing PIN logic". Built that way, the PIN would unlock the display, which the spec forbids. The privacy safeguard could be weakened without anyone noticing.
- Remediation: add Decision 37 to D2, or raise it as its own decision card. Put three questions to the owner:
  - Which PIN is meant?
  - What does "unlock" cover? Protected actions and the privacy lock are different things.
  - How does it fit with the no-lockout decision?
    Until the owner answers, keep Decision 37 out of UX8.

### HIGH-2: Decision 36 ambient weather needs a third-party integration that is not approved for MVP

- Location: plan §3D row "36"; UX8.
- Evidence: `Project-entry.md` L55 says not to assume a weather provider integration is committed to MVP; weather is only a conditional widget concept. CLAUDE.md: "Never add unapproved services".
- Impact: the plan treats this as only a €0 provider check. An unapproved external service could get added.
- Remediation: raise an owner decision for weather. The default should be ambient mode without weather (time, date, privacy-safe items only).

### HIGH-3: New personal-data tables are missing from privacy export, deletion and revocation handling

- Location: §3B rows for Decisions 6, 32, 33/34, 10/11; §5 guardrails.
- Evidence: `20261126090000_privacy_exports.sql` L974–977 already exports `account/dashboard_layout`. The proposed new tables are:
  - `dashboard_drafts`
  - `dashboard_layout_versions`
  - `dashboard_member_overrides`
  - `dashboard_suggestions_dismissed`
  - favorites and recent-Home storage
- Impact: data exports would be incomplete. Rows could also be orphaned or stay readable after account deletion, Home deletion or membership removal. A draft for the Home shared default could also survive after the user loses `manageHomeDashboard`.
- Remediation: add a guardrail and acceptance criteria to each data phase:
  - Every new table is included in the privacy export.
  - Every new table cascades on account and Home deletion.
  - Rows are purged or blocked when a member leaves.
  - A draft for the shared default is discarded or refused when the capability is revoked.
  - Multi-actor RLS/RPC tests cover each of these cases.
    Follow the `private` schema with security-definer RPC pattern from `dashboards.sql` L83–L291, with grants revoked.

### MEDIUM-1: The Decision 5 acceptance clashes with existing global vertical compaction

- Location: §3B row "4, 5"; §2 item 5.
- Evidence: `geometry.ts` L1 uses `verticalCompactor`. `readLayout`, `removeWidget`, `visiblePlacements` and `templateCopy` all compact the layout (`layout.ts` L210, L236–241, L250–256).
- Impact: the acceptance "only colliding widgets move" cannot be met, and the Decision 9 policy for gaps left by hidden widgets is still open. If compaction is changed, saved layouts render differently.
- Remediation: make compaction and the hidden-gap policy an explicit engineering decision in UX2a/UX2b, and test saved-layout stability. If it changes what users see, ask the owner.

### MEDIUM-2: The claim that `readLayout` tolerates unknown fields is wrong, which creates rollback risk

- Location: §3B row "9"; §5 bullet 2.
- Evidence: widget configs are `z.strictObject` (`widgets.ts`). `checkLayout` rejects unknown keys. `readLayout` resets the whole widget config to defaults when parsing fails (`layout.ts` L182); it does not drop only the unknown key.
- Impact:
  - If UX2a is rolled back after `emptyState` has been saved, every widget's settings are silently reset and saves are refused.
  - Retiring `welcome` in favour of the hero header (§3A row "12, 40") would drop existing widgets with "dropped" notices.
- Remediation:
  - Add rollback notes and a deploy order: readers ship before writers.
  - Keep `welcome` registered, or migrate it explicitly.
  - Correct the claim in the plan.

### MEDIUM-3: Several "Data: none" entries are wrong

- Location: §3A row "13", §3C rows "47, 49–53" and "68–71", §3D row "36", §3C row "46–48, 55".
- Evidence:
  - These need stored preferences: hiding the Ora launcher (Decision 13), the completed-task display preference (Decision 51), the category-grouping toggle (Decision 68), and the ambient timeout and ambient-visible content (Decision 36).
  - `display_configs` is per display, not per Home.
  - First task without a list: `tasks.sql` L143 `tasks_list_check` requires `list_id` for active tasks, and no "default destination rules" exist.
- Impact: hidden migrations and RLS work. Without a list, the first task needs either an atomic RPC that creates the list and the task, or an owner choice, because the doc says not to create a list silently.
- Remediation: correct the data column for each of these rows, and say which preferences store and which RPC each one uses.

### MEDIUM-4: Dependencies between phases are missing

- Location: §4.
- Problems:
  - The UX1b central Create menu (Decision 29) and the UX2a inline creation (Decision 19) need the adaptive creation dialogs. Those are built in UX3, UX4 and UX6, which the plan marks as independent of them.
  - Normal-mode widget config saves in UX2a bump `revision`. That makes the UX2b draft `base_revision` stale, with no rebase rule defined.
- Remediation: either build the creation dialogs in UX1a or a shared phase, or wire the Create menu after UX3/UX4/UX6. Also define how a draft rebases when the committed revision changes.

### MEDIUM-5: Decision 31 "Presets stay per workspace" could break the spec-required template sharing

- Location: §3B row "31".
- Evidence: `dashboards.sql` L14–16 lets templates be shared across Homes. `Modules.md` §4.1 requires "Personal templates and controlled Home template sharing".
- Impact: if presets replace templates, an existing feature required by the spec is lost.
- Remediation: say that sharing and applying templates stays unchanged and that Decision 31 adds duplicate and preview-restore on top. If the two conflict, ask the owner.

### MEDIUM-6: The D1 framing for work schedules is incomplete

- Location: §1 row "Work schedule"; §2 D1.
- Evidence:
  - `Modules.md` §4.2 is "Calendar and schedule ... native events and daily/weekly planning", and recurring native events already exist.
  - §4.2 also says unshared events, including their busy status, must be invisible to other Home members.
  - The handoff (L986) lists work schedules as a must-not-miss item.
- Impact: the owner is asked a yes/no question without the cheaper option and without the privacy constraint.
- Remediation: in D1, offer a third option, work periods as flagged native recurring events. State the §4.2 invisibility rule, and say plainly that deferring drops a must-not-miss item.

### LOW

- L1, Decision 42 (adaptive canvas): the grid stays 12 columns at every width ≥1024 px, with no maximum canvas width or minimum/maximum widget width for ultrawide screens. Add an acceptance criterion.
- L2, Decision 46: `task-view-switch.tsx` already has a Calendar view (S19c). Say whether it is kept next to Today, Upcoming, All and Lists, so existing functionality is preserved.
- L3, process:
  - "single independent review" contradicts CLAUDE.md step 7, which requires a re-review after substantive fixes.
  - The local checks leave out the build (step 5).
  - The UX phases are not in `plans/roadmap.md`.
  - `design-decisions.md` "Reference mockups" (the styling reference) also needs a note that the redesign supersedes it.
- L4, approved items not mapped:
  - replace navigation-only Quick Actions with creation actions (doc L962);
  - curated defaults plus "Choose your own" (L963);
  - undo/redo in the edit toolbar (Decision 6, L933);
  - where the Decision 7 recommendations come from (no behavioural tracking).
- L5, draft expiry is a retention policy. Show the period to the owner, and say how cleanup runs (a `packages/jobs` task or lazy delete) under the Trigger.dev rules.
- L6, history: version rows must come from the stored row in `save_dashboard`, not from the client-supplied `p_previous` (`dashboards.sql` L140).
- L7, eligibility: say whether children and Household Display accounts can use overrides, favorites and drafts. The Decision 45 preview and Decision 43 blocks need the §4.2 rule that unshared events are invisible in their acceptance criteria.

## Remaining risks and test gaps

- There is no visual baseline yet, and UX1a depends on D2. If D2 goes unanswered, the default keeps the spec token values, and most of Decisions 14–16 would not be delivered.
- The pronounced-depth tokens could fail contrast with extreme accents. UX1a needs automated contrast tests in both themes.
- The Home overrides (UX2d) and the display unlock (UX8) are the highest-risk security slices. Both need multi-actor RLS tests, including forged `home_id`, revoked membership and stale Realtime and query caches.
- Storage: 10 versions × 64 KB × each workspace, on the Supabase free tier. Note it in the provider-cost register.
