# Madeora User Stories

**Purpose:** Map the user-facing workflows represented in the current repository and give contributors concise acceptance checks.  
**Scope:** Implementation-aligned documentation, not a replacement for approved product requirements.  
**Last reviewed:** 11 November 2026

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

### US-039 — Protect and recover my adult account

As an adult account holder, I want strong sign-in, session and recovery controls so I can protect my account and regain access without exposing it to a Home.

**Acceptance checks**

- I can optionally enable authenticator-app two-factor sign-in after recent reauthentication, save newly issued single-use recovery codes, use either a current authenticator code or an unused recovery code at sign-in, and disable the factor only after reauthentication.
- I can trust the current browser for 30 days after completing two-factor sign-in, review trusted browsers, and revoke one or all of them; security-sensitive account events clear existing trust.
- I can review my active sessions and revoke another session, report it and sign it out, or sign out everywhere. A revoked session and a session still waiting for its second factor are refused on their next protected database request.
- Changing my password, email address, sign-in methods or recovery settings requires a fresh password or Google reauthentication and, when enabled, the second factor. A password change leaves only the authorized current session signed in; an email change requires the new address to confirm and can be cancelled while pending.
- I can confirm a backup email and create separate account-recovery codes. Signed-out account recovery requires the configured recovery proof and enforced waiting period before it can finish.
- Security notifications and recovery messages go through the configured email jobs, while recovery secrets, device tokens and security events remain private to my account.
- No Home membership, role or cross-Home permission grants access to my security settings, sessions, trusted browsers or recovery methods.

### US-040 — Review account activity and respond to security events

As an account holder, I want a private activity history, useful alerts and downloadable security reports so I can understand and respond to important account events.

**Acceptance checks**

- I can review my account activity with the supported category, Home and date filters; the history describes account, security, profile, integration and Home-membership events without exposing another account's private activity.
- I can choose optional alerts for a new device and for every successful sign-in, while mandatory security notifications remain mandatory.
- I can identify an unfamiliar sign-in and use the offered response; the response applies to the relevant session/account event and is itself recorded.
- After recent reauthentication, I can request a security-activity report for a valid retained date range, download it as CSV or JSON while it is ready, or discard it. Report creation and download do not bypass account or session checks.
- Activity and security reports remain account-private; Home roles and membership never grant another person access.

### US-041 — Switch, deactivate and reactivate my account safely

As a person using a shared device, I want to switch remembered accounts or temporarily deactivate mine without leaking one account's data into another.

**Acceptance checks**

- I can choose whether this device remembers my account; remembered entries contain only the limited display information needed by the account chooser, not a reusable sign-in session.
- Adding or switching to another remembered account signs out the active account on that device, clears client-side account state, and requires the selected account's own sign-in and second factor when enabled.
- Removing an entry from the device does not deactivate or delete that account.
- Temporary deactivation requires acknowledgement and recent reauthentication, is blocked while I am the sole Owner of a Home, revokes sessions and trusted browsers, and prevents normal use until reactivation.
- Signing in to a deactivated account permits only the reactivation flow, including the second factor when enabled. Reactivation ends that restricted session and requires a fresh sign-in before normal access resumes.
- Deactivation, reactivation and switching preserve personal and cross-Home isolation; ownership cannot be transferred to a deactivated member.

### US-042 — Review privacy settings and export permitted data

As an account holder or authorized Home member, I want to review privacy settings and export permitted data so I can understand and retrieve information without crossing access boundaries.

**Acceptance checks**

- The privacy dashboard distinguishes account-, Home- and device-scoped settings. Its guided review records progress but does not silently change a setting.
- After recent reauthentication, I can request all eligible personal data or selected categories and choose which Homes contribute my own Home-specific settings and contributions; other members' private data and unrelated Home records are excluded.
- A Home export is available only to the Owner or a member explicitly granted `exportHomeData`; module, record and membership access are rechecked while building and downloading it.
- Exports are prepared by the background job as a private ZIP with a manifest, README and JSON/CSV data. Eligible media is included within the documented 100 MB cap, and omissions make the result visibly partial.
- A ready export expires after seven days, requires a fresh authorization check before a short-lived download, and is invalidated when relevant access or source data changes. Cancellation, download, expiry and failure states are visible.
- Personal exports, Home exports and their archives remain isolated by account and Home. Losing a Home or export permission ends access without granting a copy of data that is no longer permitted.
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

### US-029 — Keep my own points and rewards without any Home

As a person, with or without Homes, I want a personal points balance and rewards I define myself, so I can reward my own progress where no Home and nobody else can see or change it.

**Acceptance checks**

- With zero Homes I can open my personal points and rewards; I see my available, earned and spent points and my ledger.
- I can add points or correct my balance with a reason after a preview, and reverse one of those entries once; a correction never takes my balance below zero.
- I define my own rewards with a cost and an optional window, total limit and limit per week, month, year or in total; editing shows how often it was redeemed and never changes past redemptions; archiving keeps the history.
- Redeeming shows the cost and my balance after and takes the points at once; I mark it fulfilled or unable to fulfill, and resolve Unable once with a refund or a note of what I chose instead.
- No other account, no role in any Home and no Madeora staff account can see or change my personal points or rewards; leaving or deleting a Home changes nothing in them, and my Home points never mix with them.
- The Personal points widget is offered on my personal dashboard only.

### US-023 — Plan chores around vacations and temporary absences

As a Home member, I want vacations and temporary absences reflected in chore planning so work remains fair while people are away.

**Acceptance checks**

- I can see vacations for a Home where I am a current member; invitations, participation changes and date proposals are available only to the people and chore managers allowed to act on them.
- Accepted vacation dates affect only the intended Home: rotating chores pass to an available member, and a chore manager can preview and confirm a Home-wide pause without silently combining separate vacations.
- A chore manager can review affected occurrences and choose the supported keep, skip, reassign or one-off reschedule action; assigning someone who is away requires an explicit confirmation.
- I can register my own temporary chore absence, while a chore manager can register one for another member. Its optional reason stays private to that member and chore managers, and the absence does not change chores automatically.
- Vacation and absence actions preserve occurrence history, concurrency safeguards and cross-Home boundaries; the optional reminder and dashboard widget reveal only the scope allowed by their workflow.

## 6. Recipes

### US-024 — Keep, share and cook from recipes

As a person or Home member, I want to keep recipes in my Personal space or a Home and cook from them, so the household shares one trusted version of each recipe.

**Acceptance checks**

- I can save a recipe as a draft that only I can see, anywhere, even when it is meant for a Home; it appears only in My drafts until I publish it, and publishing names who will see it.
- A published recipe belongs to its Personal space or Home; the Home's current members can find it by name, ingredient and tags, favorite it, rate it and see the average of current members' ratings, never who rated what.
- Only the creator, the Owner and Administrators allowed to manage Home recipes can edit or delete it; while one person edits, everyone else sees who is editing and cannot save over them. An abandoned edit frees itself within minutes, and a lost edit never overwrites newer content.
- I can scale the ingredients to another number of servings with exact amounts, and follow the steps one at a time in cooking mode, which tells me when the recipe changes or is no longer available.
- A recipe can carry one cover photo, and a dashboard widget shows my favorites, recent, highest rated or a random recipe from the context I may see.

### US-025 — Share recipes between Homes and import them from the web

As a recipe manager, I want to share a recipe with another Home I belong to and import recipes from websites, so households use one trusted version without retyping or copying.

**Acceptance checks**

- I can share a published recipe with another Home I belong to, view only or letting that Home's recipe managers edit it; it stays one recipe, so a saved change shows everywhere it is shared, and the share can be removed or changed at any time.
- Members of a Home it is shared with see it marked as shared, without the origin, its members or other Homes being named; they rate and favorite it in their own Home, and cannot delete or share it onward.
- Deleting a shared recipe first lists the Homes it is shared with, its favorites and whether someone is editing; a change in the meantime asks me to look again, and after a restore the shares stay paused until I turn them back on.
- I can paste a recipe's web address and get an editable preview with its source, what is missing or uncertain and possible duplicates; nothing is saved until I save or publish, and the recipe keeps its source link.
- An address that is private, local, too slow, too large, not a web page or without recipe data is refused with the reason and a way to enter the recipe myself.

## 7. Shopping

### US-026 — Shop together from shared lists

As a person or Home member, I want to keep several shopping lists, add items quickly and check them off together, so everyone in the shop knows what is still needed.

**Acceptance checks**

- I can keep several lists in my Personal space or a Home, with duplicate names told apart by their place, archive them, and delete them to the trash with their items.
- I can quick add an item by name or review several lines before adding them; a clear quantity and unit are read only when unambiguous, and an item already on the list is flagged so I keep it as a separate item or cancel; nothing is merged.
- An item can carry a quantity, unit, packaging, notes and one of the list's own categories; I order lists, categories and items with Move up and Move down.
- When another member checks an item off it moves to Completed on my open page with who did it, without reloading; clearing completed items asks first and can be undone from the trash.
- I can move or copy an item to another active list of the same Personal space or Home only, keeping or reopening its completion, and undo a move.
- A repeating item adds itself again on its days only when the last one is no longer active, and missed days never pile up.
- List managers set whether other members may edit, only check off, or only view a Home list; the Shopping widget shows one list or several combined with each item's list.

## 8. Meals

### US-027 — Plan the week's meals and shop for them

As a person or Home member, I want to plan meals in slots for each day, repeat the regular ones and send their ingredients to a shopping list, so the household knows what is for dinner and what to buy.

**Acceptance checks**

- My Personal space and each Home have a planner by week or day with Breakfast, Lunch and Dinner from the start; meal managers rename, reorder, add, disable and re-enable slots, and disabling shows what it affects first.
- I can plan a recipe (with servings) or a custom meal with notes in an empty slot; a taken slot is never overwritten without my explicit choice, and a removed meal goes to the trash.
- A recipe I can no longer see from the planner's place shows as "Recipe unavailable" without revealing anything of it.
- A repeating meal (daily, chosen weekdays or weekly, with an optional end) shows its collisions before saving; I can change, move or skip one occurrence, change it from a date on without changing the past, pause, resume and end it.
- I can copy a week to another week after reviewing each meal, with unavailable recipes, disabled slots and taken slots flagged.
- I can review the scaled ingredients of the meals in a date range, edit or leave out rows and add them to a list of the same place; they are then checked off like any other item.
- The print view shows the week without navigation, with notes left out unless I include them; the Meal planner widget shows today, a chosen day or a compact week.
- Meal managers can make a Home's planner view only for other members.

## 9. Habits

### US-028 — Build habits alone or together and keep streaks honest

As a person or Home member, I want to track habits on a schedule, check in today or for a recently missed day, and see streaks and insights that stay correct after corrections, so I can build routines on my own or with my household.

**Acceptance checks**

- I can create a personal habit, and habit managers can create Home habits, with a daily, chosen-weekday or weekly-target schedule, a start date, an optional end date and a description; a personal habit keeps its own timezone and every habit shows its week start.
- I can complete today or any of the last 7 days that was scheduled, tracked and not paused; a confirmation offers Undo for 10 seconds, and a Home habit's date is completed once, showing who did it.
- Streaks count consecutive completed opportunities (or reached weeks for weekly habits), skip paused days and weeks, and recalculate after Undo, backdating and manager corrections; the longest streak and milestones at 7, 30 and 100 are kept, with an optional short celebration.
- Habit managers change a schedule from a later date only, set or change an end date with a preview, pause and resume with an optional resume date, archive, delete to the trash, and reactivate an ended habit with a fresh streak and a reminder review.
- Insights show the completion rate over 7, 30, 90 or 365 days, a month calendar with every state and a text list, and a 12-week trend with its values as text.
- Reminders (up to three times on chosen days) are sent only when the day still needs a check-in; from the notification centre I can complete the habit or snooze it for 15, 30 or 60 minutes, never into my quiet hours.
- During my accepted participation in a Home vacation I can pause chosen personal habits; a Home habit pauses on the vacation's confirmed Home-wide pause days.
- The Habits and Habit insights widgets show today's habits with Complete and Undo, and one habit's last 30 days; Home members can be set to view only.

### US-030 — Track a habit by a daily numeric target

As a person or Home member, I want a habit such as water or reading to complete when I reach a daily amount, so I can add progress in steps and see how far I am.

- A daily or chosen-weekday habit can use a numeric daily target in a unit (glasses, pages, repetitions, mL, L, min, h, m, km or a label of my own); weekly habits stay complete-once.
- I add progress with quick-add buttons or by typing an amount in my own number format (Dutch `1,5`, English `1.5`); the other separator, thousands separators and more than three decimals are refused with a reason, and I see the normalized amount before saving.
- I can enter a compatible unit (L for mL, h for min, km for m) and the amount is converted exactly; a conversion needing more than three decimals is refused.
- The day completes once when the total reaches the target; going over is shown and never carries to the next day; the next day starts at zero.
- I can undo my own contributions for 7 days; managers correct or amend any, with the original kept. Nothing is ever deleted.
- Managers change the target or unit from today, the next scheduled day or a chosen date after a preview of the impact, confirming a same-day status change; past days keep the target they had.
- Each day has one optional note. Daily totals are listed without a timeline of contributions: only the contributor and the habit's managers see who added what.
- Reminders stop when the target is reached and, while it is not, say how far I am; the Habit progress widget shows one numeric habit with quick-adds.

### US-031 — Reach goals alone or together

As a person or Home member, I want to set goals with a target or a single completion, add progress together and mark them achieved, so we can see how far we are and keep what we reached.

- I can create a personal goal, and goal managers can create Home goals: a completion goal, or a measurable goal with a target in a unit (the habit units or a label of my own), optional initial progress, deadline and description.
- I add progress in my own number format; decimals add up exactly, I see the resulting total before saving and can Undo for 10 seconds. Going over the target is kept and shown, the bar stops at 100%.
- Every contribution is listed with who and when. I can reverse my own; managers can set the total and correct or reverse any entry with a reason. Nothing is deleted and the total never goes below zero.
- Reaching the target only shows "Target reached": the goal is achieved when someone allowed marks it achieved. Achieved goals move to Completed; reopening keeps the achievement in the history.
- Managers change the target or unit with a preview and an explicit confirmation when it changes the status or reinterprets progress; an achieved goal can be extended or renewed as a follow-up goal that starts at zero.
- A goal with a deadline shows Overdue after it; optional reminders a number of days before and after the deadline are never sent late, and each Home member can turn them off for themselves.
- Managers archive, delete to the trash and restore goals, and can set Home members to view only. Personal goals are never visible to anyone else.
- The Goals widget lists active goals with Add progress and Mark achieved; the Goal progress widget shows one chosen goal.

### US-032 — Repeat a goal every week, month or year

As a person or Home member, I want a goal that starts again every week, month or year, so each period has its own target and result while earlier periods keep theirs.

- When I create a goal I can make it repeat: measurable goals weekly, monthly or yearly, completion goals monthly or yearly, from this period or a later one, optionally until an end date and with a reminder a number of days before each period ends. I see the first and next periods before I create it.
- The period running now appears with my other active goals, marked Weekly, Monthly or Yearly, and starts at zero; missed periods are never added afterwards.
- When a period ends, its result (target reached or not) is kept. Nobody adds progress to it afterwards; goal managers can still correct it, and the result follows, marked "corrected". A period marked achieved that a correction took below its target asks for review.
- Goal managers change the target from the current period or a later one with a preview; earlier periods keep their target. Changing the current period asks for confirmation when it changes whether the target is reached.
- Goal managers pause, resume and stop a repeating goal, edit it for later periods and delete it to the trash with all its periods. The series page shows the target schedule and every period with its result.

### US-033 — Let a numeric habit count toward a goal

As a person or Home member who manages both a numeric habit and a measurable goal, I want the habit's progress to count toward the goal automatically, so I record an activity once.

- On a measurable goal or repeating goal I can link a numeric habit of the same Personal space or Home whose unit fits (the same unit, a convertible one such as m and km, or the same custom unit). I choose to count from today, from a date or from the habit's beginning, and see the linked amount and the new total before I confirm.
- The goal shows how much is manual and how much comes from linked habits. Every change to the habit (adding, Undo, a correction, a missed day filled in later) updates the goal straight away; a correction in a period that has ended updates that period's result.
- One habit can count toward several goals, and several habits toward one goal; each habit day counts once per goal. A goal keeps counting after it is achieved.
- I can change the start date or unlink, each with a preview. Unlinking either keeps the amount as manual progress or removes it.
- The habit page lists the goals it counts toward. People who can see the goal see which habits feed it and how much, never who recorded each entry.

### US-034 — Keep pet profiles and medical history

As a Home member, I want one place for our pets' details and medical history, so anyone looking after them knows what they need, while medical information stays with the people we choose.

- Owners and Administrators with the right to manage pets add a pet with only its name and fill in the rest later: species (or a custom one), breed, a birth date or an approximate age with the date it was true, sex, neutered, weight with its unit, veterinarian, diet, care instructions, notes and a photo. Every member sees these.
- A field can be left empty, filled in, or marked Unknown; allergies and medications can also be recorded as None. Empty is never shown as None.
- Allergies, medications, identification numbers, medical notes, the medical history and its documents are visible only to members granted medical access (View, or View and edit) for this Home, and to the Owner. Without it, nothing in the app or the trash shows whether a pet has any medical records.
- People who may edit medical information add entries (vet visit, vaccination, treatment, test or diagnosis, surgery, other) with a date, optional details and a follow-up date, attach images or PDFs, correct and delete them. Entries after today show as Upcoming appointments; the rest form the history, newest first.
- The Owner, and Administrators granted the right, set each other member's medical access on the member's page. It works from the member's next action, is recorded in the Home's audit log, and ends when they leave the Home.
- Deleting a pet moves it, with its medical information, to the trash for 7 days, where only people who may manage pets and edit medical information can restore it or delete it for good; deleted medical entries and documents are in the trash only for people who may edit medical information.

### US-035 — Share our pets' daily care

As a Home member, I want our pets' care on a schedule with who does it, so nothing is forgotten or done twice.

- People who may manage pets add care to a pet: a title, a category (feeding, medication, grooming, vet appointment, other), instructions, once on a date or repeating (daily, weekly on chosen days, monthly, yearly, every so many), an optional time and the members responsible. Care without anyone responsible shows as Unassigned.
- Every member sees the care and marks it done; the pet's page and the care's page show what is upcoming, due, overdue, done (by whom and when) or skipped. Missed care stays overdue; nothing is marked done automatically.
- Managers change one time only, or the schedule from a chosen time on, and pause, resume, end or delete care. The person who recorded care, or a manager, can correct when it was done or reopen it.
- Medication, and any care marked as containing medical details, shows only its category to members without medical access: never its title, instructions or notes.
- Responsible members can get a reminder at the time or 15 minutes, 1 hour or 1 day before. The Pet care widget shows the Home's open care with Done, and the reminder before a vacation says how much pet care continues during it.

### US-036 — Keep my calendar and share chosen events with a Home

As a person, I want my own calendar and a calendar for each Home, so I can plan alone and together without showing anyone what I keep private.

- I add events to my personal calendar or a Home's: all-day or timed in a timezone, with a location, a description, a repeat rule, participants (a Home event) and an optional reminder at the start or 15 minutes, 1 hour or 1 day before.
- A personal event stays mine: other members see nothing of it, not even that I am busy, unless I share that event with a Home, where they see it read-only with "Shared by" and my name. Its reminder is only for me.
- Changing or deleting a repeating event asks: this event, this and following, or all events, and lists the affected dates first. Deleting the whole event goes to the trash for 7 days.
- In a Home every member may add and change events; who may also delete them is set per member. The calendar shows the Home's vacations as banners I can hide, and Show tasks and Show chores lay tasks and chores over it, remembered for each calendar.
- The Upcoming events widget shows the next events of my personal space or a Home.

### US-037 — Connect and safely synchronize Google Calendar

As a person, I want to connect chosen Google calendars and optionally show them in selected Homes, so I can coordinate existing events without exposing calendars I kept private.

**Acceptance checks**

- I can connect one Google account, choose which calendars synchronize, show chosen calendars in my Personal calendar and share chosen calendars with selected Homes; an unshared calendar reveals no event, busy time, name, count or sync state.
- Google events marked private or confidential remain visible only to me, even when their calendar is shared with a Home. Other current Home members see allowed shared events read-only and see who shared them.
- Sync uses the connected account only, reports syncing, stale, failed or expired authorization honestly, supports Sync now with rate limiting, and lets me reconnect without exposing or losing the stored event view.
- For a Google calendar I may write to, I can create, edit or delete events from Madeora. Pending changes are visible until Google accepts them, retries are idempotent, and an external conflict waits for my explicit choice between the Madeora and Google versions.
- Removing a Google event from Madeora hides it without deleting it from Google and can be restored; Delete everywhere removes it through Google. Recurring changes use the supported occurrence, this-and-following or whole-series scope.
- OAuth state, refresh tokens and token encryption remain server-only; calendar access and changes never cross accounts or Homes.

### US-038 — Keep and selectively share photo memories

As a person or Home member, I want private photo libraries and albums that I can share deliberately, so memories are easy to revisit without weakening storage or Home boundaries.

**Acceptance checks**

- I can upload supported images to my Personal library, and authorized members can upload to a Home library. The app validates and processes the image into its private optimized master and derivatives, applies orientation, refuses corrupt content and does not retain the original upload.
- Photos count against the correct Personal or Home storage allowance. I can place one photo in several albums without duplicating it, and removing it from an album does not delete it from the library.
- Home photo-management actions respect the delegated capability. Personal photos remain private unless an album containing them is explicitly shared through the supported workflow.
- An album can be shared with another Home as view-only or with contribution access without copying its photos. The destination learns only the shared album; leaving, removing the share or choosing Remove from this Home ends access without deleting the source photos.
- Library deletion shows the affected albums and shares before confirmation. Trash, restore and permanent deletion retain the original context and permissions, and storage objects remain accessible only through authorized signed reads.
- The Photos widget rechecks access for each viewer and can show an allowed photo, selected photos or an album as a static image or slideshow.

## 10. Notifications

### US-015 — Review and configure notifications

As a person using Madeora, I want to review notifications and set my notification preferences so I can keep up with relevant activity.

**Acceptance checks**

- I can open the notifications area and see items available to my account.
- I can manage supported notification preferences.
- Notifications respect account and Home access boundaries.

## 11. Files, trash, and recovery

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

## 12. Cross-cutting expectations

These checks apply to every story above:

- Authorization is checked on the server and in database policies; hiding a control in the UI is not sufficient.
- Personal data and each Home's data remain isolated.
- Destructive or irreversible actions make the affected context clear and require the specified confirmation.
- Forms and actions provide understandable validation, loading, success, empty, and error states.
- The experience remains usable on supported screen sizes and with keyboard navigation.
- Automated tests cover important behavior and access boundaries, especially database RLS policies.

## Implementation evidence for security, activity, privacy, lifecycle, chore, vacation, points, rewards, recipe, shopping, meal, habit, goal, pet, calendar, integration and photo workflows

The additional workflows are represented by [account-switching and lifecycle browser tests](../tests/e2e/specs/account-switching.spec.ts), [privacy-review and export browser tests](../tests/e2e/specs/privacy-lifecycle.spec.ts), activity unit and component tests under `apps/web/src/activity/` and `apps/web/src/components/activity/`, privacy component tests under `apps/web/src/components/privacy/`, [privacy-export job tests](../packages/jobs/src/jobs/privacy-export.test.ts), activity, lifecycle and export database/RLS tests under `tests/db/rls/`, [adult-security browser tests](../tests/e2e/specs/adult-security.spec.ts), [security component tests](../apps/web/src/components/security/security.test.tsx), [account-recovery component tests](../apps/web/src/components/security/recovery.test.tsx), authentication unit tests under `apps/web/src/auth/`, [trusted-device route tests](../apps/web/src/app/api/v1/me/trusted-device/route.test.ts), [adult-security database/RLS tests](../tests/db/rls/adult_security.test.sql), [chore pool browser tests](../tests/e2e/specs/chore-pool.spec.ts), [chore overview browser tests](../tests/e2e/specs/chore-overview.spec.ts), [chore workflow browser tests](../tests/e2e/specs/chores.spec.ts), [Home vacation browser tests](../tests/e2e/specs/home-vacations.spec.ts), [points and rewards browser tests](../tests/e2e/specs/points-rewards.spec.ts), [recipe browser tests](../tests/e2e/specs/recipes.spec.ts), [shopping list browser tests](../tests/e2e/specs/shopping.spec.ts), [meal planner browser tests](../tests/e2e/specs/meal-planner.spec.ts), [habit browser tests](../tests/e2e/specs/habits.spec.ts), [numeric-habit browser tests](../tests/e2e/specs/numeric-habits.spec.ts), [personal points and rewards browser tests](../tests/e2e/specs/personal-points-rewards.spec.ts), [goal browser tests](../tests/e2e/specs/goals.spec.ts), [recurring-goal browser tests](../tests/e2e/specs/recurring-goals.spec.ts), [habit-to-goal link browser tests](../tests/e2e/specs/habit-goal-links.spec.ts), [pet-profile browser tests](../tests/e2e/specs/pets.spec.ts), [pet-care browser tests](../tests/e2e/specs/pet-care.spec.ts), [calendar browser tests](../tests/e2e/specs/calendar.spec.ts), [Google Calendar route tests](../apps/web/src/app/api/v1/integrations/google-calendar/google-calendar.test.ts), [Google event route tests](../apps/web/src/app/api/v1/calendar/google-events/google-events.test.ts), tests for the Google client, encryption, normalization, push and sync behavior under `packages/google-calendar/src/`, [photo-library route tests](../apps/web/src/app/api/v1/photos/photos.test.ts), [photo-sharing route tests](../apps/web/src/app/api/v1/photos/photo-sharing.test.ts), [photo component tests](../apps/web/src/components/photos/photos.test.tsx), and their corresponding database and concurrency tests under `tests/db/`. The migrations define the schema and authorization layer, but are not treated as proof that a workflow is implemented. These tests verify selected paths; they do not certify every product requirement or all failure and permission cases.

## Repository areas to verify

The current implementation is represented primarily by:

- `apps/web/src/app/(app)/` and `apps/web/src/components/` for screens and UI.
- `apps/web/src/app/api/` for application routes.
- `supabase/migrations/` for schema and RLS policy history.
- `tests/e2e/` and `tests/db/` for browser, database, and authorization checks.
- `docs/production-migrations.md` for the production migration sequence.

Update the relevant stories when these workflows change, and check the product specification before extending scope.
