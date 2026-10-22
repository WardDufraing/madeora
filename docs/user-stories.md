# Madeora User Stories

**Purpose:** Map the user-facing workflows represented in the current repository and give contributors concise acceptance checks.  
**Scope:** Implementation-aligned documentation, not a replacement for approved product requirements.  
**Last reviewed:** 22 October 2026

> **Source of truth:** `docs/product/Project-entry.md`, `Modules.md`, and `Project-specification.md` remain the binding product documents. This file summarizes workflows visible in the repository. A listed story does not mean every product-level requirement or edge case is complete. When code, tests, and this summary disagree, verify the behavior and update this file; do not silently change the binding product requirements.

## How to use this document

- Read the product documents before changing product behavior.
- Use these stories as a navigation aid for implemented workflows and a checklist during review.
- Verify acceptance checks against the UI, server routes, database policies, and tests. Add or revise checks when a feature changes.
- Keep future or not-yet-implemented product scope in the product documents; do not mark it implemented solely because it is specified there.

## 1. Account and personal preferences

### US-001 — Manage my personal account preferences

As a signed-in person, I want to manage my profile and regional preferences so Madeora presents information in a way that works for me.

**Acceptance checks**

- I can update my display name and language.
- I can set regional formats and a timezone.
- My saved preferences persist and are used by the app.
- Private account preferences are not exposed to other Home members.

## 2. Personal dashboard

### US-002 — Use Madeora without joining a Home

As a person who has not joined a Home, I want a personal area so I can use Madeora for myself.

**Acceptance checks**

- I can reach my personal dashboard after signing in.
- The personal area remains available when I have no Home membership.
- Personal dashboard content is kept separate from Home-shared content.

### US-003 — Configure dashboard content

As a dashboard owner, I want to configure available widgets and templates so the dashboard is useful to me or my Home.

**Acceptance checks**

- I can access dashboard configuration and available templates.
- Widget and template actions respect the applicable personal or Home permissions.
- Empty, loading, and unavailable states are understandable.

## 3. Homes and membership

### US-004 — Create a Home

As a signed-in person, I want to create a Home so I can coordinate shared household information.

**Acceptance checks**

- I can start a Home creation flow and provide the required details.
- A successful creation gives me access to the new Home.
- The creator receives the appropriate ownership and membership state.

### US-005 — Invite people to a Home

As an authorized Home member, I want to invite someone so we can coordinate together.

**Acceptance checks**

- I can create and manage invitations when my permissions allow it.
- An invitee can follow a valid invitation or join link.
- Invalid, expired, already-used, or unauthorized invitation actions produce a clear outcome.
- Accepting an invitation adds the intended account to the intended Home only.

### US-006 — Manage Home members and profiles

As an authorized Home member, I want to view member information and manage permitted membership settings so the Home stays organized.

**Acceptance checks**

- I can view the Home's member directory.
- Member profile and membership actions are limited by role and permissions.
- Membership changes apply to the selected Home and do not expose another Home's information.

### US-007 — Leave a Home

As a Home member, I want to leave a Home when I no longer participate so my access ends cleanly.

**Acceptance checks**

- I can review and confirm the leave action.
- After leaving, I no longer have access to that Home's protected information.
- Ownership and last-owner safeguards prevent an invalid transfer of control.

## 4. Tasks and planning

### US-008 — Organize personal or Home tasks

As a person with access to a personal space or Home, I want to create and manage tasks so responsibilities are visible and trackable.

**Acceptance checks**

- I can view tasks in the context where I have access.
- I can create, edit, complete, and reopen or otherwise manage tasks using the available actions.
- Task visibility and assignment follow the selected personal or Home context and its permissions.

### US-009 — Plan tasks on a calendar

As a person managing tasks, I want a calendar view so I can understand when work is scheduled.

**Acceptance checks**

- I can open the task calendar for my personal context or a Home where I have access.
- Scheduled tasks appear in the relevant date view.
- Calendar actions link back to the correct task and preserve access checks.

### US-010 — Repeat tasks and use reminders

As a person managing recurring responsibilities, I want to configure recurrence and reminders so repeated work is easier to remember.

**Acceptance checks**

- Available task recurrence settings can be created and managed.
- Reminder settings are associated with the correct task and context.
- Invalid or unavailable schedules are handled without silently creating an unintended task.

### US-011 — Reuse task templates and make bulk changes

As a person managing several similar tasks, I want templates and bulk actions so I can set up and maintain work efficiently.

**Acceptance checks**

- I can view and use task templates where permitted.
- Applying a template creates tasks in the intended context.
- Bulk actions show the affected tasks and respect access permissions.

### US-012 — Attach files to tasks

As a person working on a task, I want to attach relevant files so collaborators can find supporting information.

**Acceptance checks**

- I can attach and access files only where I have permission.
- Removing a task or losing Home access does not bypass the file-storage access rules.
- Upload or download failures are communicated clearly.

## 5. Chores

### US-013 — Coordinate household chores

As a Home member, I want to manage chores so recurring household responsibilities are visible and can be shared.

**Acceptance checks**

- I can view and manage chores in a Home where I have permission.
- Available chore management actions respect member roles.
- Chore templates and bulk operations apply to the intended Home.

### US-014 — Review chore completion and history

As a Home member, I want to review chore history and handle approvals so completed work can be checked where the Home requires it.

**Acceptance checks**

- I can see the relevant chore occurrence and its history.
- Approval actions are available only to authorized members.
- Approval and history records refer to the correct Home and occurrence.

### US-019 — Claim unassigned chores and hand over assignments

As a Home member, I want to claim an available chore occurrence or request a reassignment so unassigned work and handovers are visible and coordinated.

**Acceptance checks**

- I can see eligible unassigned chore occurrences in the pool for the Home I am viewing.
- A successful claim removes that occurrence from the available pool for other members; concurrent attempts do not give it to more than one person.
- I can undo or release my own claim where the current rules allow it.
- A reassignment request shows its chore and reason, and an authorized response applies only to that occurrence in that Home.
- Pool and request actions remain subject to Home membership and role checks.

### US-020 — Propose chores and respond to volunteer requests

As a Home member, I want to propose a chore or respond to a targeted volunteer request so the Home can add responsibilities and find volunteers through a reviewable process.

**Acceptance checks**

- I can submit a proposal for review; it is shown as pending until an authorized member decides it.
- The decision and resulting chore are visible in the same Home.
- A targeted volunteer request shows its deadline and lets an invited member respond.
- A volunteer offer is not shown to unrelated members, and assignment changes apply only to the intended occurrence and Home.

### US-021 — Plan the chore schedule and configure reminders

As a Home member, I want to review the chore schedule and manage my reminders so I can plan upcoming household responsibilities.

**Acceptance checks**

- I can view scheduled and unassigned occurrences in the Chores calendar and schedule widget for a Home where I have access.
- Moving an occurrence shows the proposed date change before it is applied; the saved occurrence remains in the correct Home and schedule.
- I can configure or remove my supported personal reminder for an occurrence.
- I can view and save the Home's daily summary settings only when authorized; another Home member's setting is not exposed as my personal preference.
- Schedule, reminder, and summary actions preserve Home access boundaries.

### US-022 — Earn chore points and redeem rewards

As a Home member, I want completed chores to earn points that I can spend on the Home's rewards so household work is recognised.

**Acceptance checks**

- A chore shows its points; completing it adds them to my Home balance once, even when it is approved later, corrected or retried. A late completion follows the chore's late policy.
- I see my own available, reserved, earned and spent points and my ledger; other members cannot see them. Only members allowed to manage points see everyone's balances and can add a bonus or correction with a reason, after a preview.
- Redeeming a reward shows the cost and my points after; a reward that needs approval reserves the cost until a different authorized member approves or rejects it. I can cancel my own pending request.
- Limits, the availability window and an archived or disabled reward are enforced by the server; my points stay with my membership in that Home only and never expire.
- The leaderboard is optional for the Home and for each member; the weekly points and leaderboard widgets show only what I may see.

## 6. Notifications

### US-015 — Review and configure notifications

As a person using Madeora, I want to review notifications and set my notification preferences so I can keep up with relevant activity.

**Acceptance checks**

- I can open the notifications area and see items available to my account.
- I can manage supported notification preferences.
- Notifications respect account and Home access boundaries.

## 7. Files, trash, and recovery

### US-016 — Store and access private files

As a person or authorized Home member, I want files stored privately so supporting information is available only to the people allowed to see it.

**Acceptance checks**

- File access requires the relevant account or Home authorization.
- A user cannot access another user's or unrelated Home's files by changing an identifier or link.
- Storage errors do not expose credentials or private object locations.

### US-017 — Recover deleted information

As a person or authorized Home member, I want a trash and recovery flow so I can restore supported items deleted by mistake.

**Acceptance checks**

- I can view recoverable items in the correct personal or Home context.
- Restore and permanent deletion actions follow the applicable permissions and safeguards.
- Restored information returns to the intended context without exposing it to unrelated members.

### US-018 — Resolve Home ownership recovery

As a person responsible for a Home, I want a safeguarded ownership-recovery process so a Home can regain an accountable owner when needed.

**Acceptance checks**

- Recovery requests and decisions are limited to authorized people and staff workflows.
- The recovery record identifies the affected Home and status.
- Applying a recovery does not silently change unrelated Home memberships or ownership.

## 8. Cross-cutting expectations

These checks apply to every story above:

- Authorization is checked on the server and in database policies; hiding a control in the UI is not sufficient.
- Personal data and each Home's data remain isolated.
- Destructive or irreversible actions make the affected context clear and require the specified confirmation.
- Forms and actions provide understandable validation, loading, success, empty, and error states.
- The experience remains usable on supported screen sizes and with keyboard navigation.
- Automated tests cover important behavior and access boundaries, especially database RLS policies.

## Implementation evidence for chore workflows

The additional chore stories are represented by [chore pool browser tests](../tests/e2e/specs/chore-pool.spec.ts), [chore overview browser tests](../tests/e2e/specs/chore-overview.spec.ts), [chore workflow browser tests](../tests/e2e/specs/chores.spec.ts), [points and rewards browser tests](../tests/e2e/specs/points-rewards.spec.ts), and the corresponding migrations in `supabase/migrations/`. These tests verify selected end-to-end paths; they do not certify every product requirement or all failure and permission cases.

## Repository areas to verify

The current implementation is represented primarily by:

- `apps/web/src/app/(app)/` and `apps/web/src/components/` for screens and UI.
- `apps/web/src/app/api/` for application routes.
- `supabase/migrations/` for schema and RLS policy history.
- `tests/e2e/` and `tests/db/` for browser, database, and authorization checks.
- `docs/production-migrations.md` for the production migration sequence.

Update the relevant stories when these workflows change, and check the product specification before extending scope.
