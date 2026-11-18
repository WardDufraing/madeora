# ADR 0056: Review backlog owner decisions

- **Status:** Accepted. Records answers the owner gave to open questions raised by the review backlog (`plans/steps/fix-review-backlog-brief.md`, decisions log). Changes no code or schema.
- **Date:** 2026-11-17
- **Decided by:** Ward.

## Context

The review backlog left a number of "owner should confirm" items in earlier ADRs and reviews. Ward answered them one by one on 2026-11-17. Some answers confirm what was built; others asked for a code change, made in PR #97.

## Decisions accepted as built or confirmed

1. **S24-M4, unsaved recipe cover.** An unsaved cover change reverts to the saved cover. No extra retention of the unsaved upload (built in PR #93).
2. **S41-M1, child sign-in account at creation.** A child's Supabase Auth user, with an internal non-deliverable email alias, is created when the child profile is created, not when sign-in is first enabled. Sign-in stays off until a guardian switches it on. `architecture.md` section 34 is updated in a separate PR.
3. **S23-L4, deleting a completed one-off chore.** Points already awarded are kept.
4. **S35-M3, libheif-js (LGPL-3.0).** Approved. It is used unmodified, as a separate dependency (`heic-decode` pulls `libheif-js`), kept external to the server bundle, with no change to its source. Requirements: keep the licence and copyright notices with the dependency, list it in the third-party notices, do not patch or fork it without a new decision, and keep it replaceable (a plain package dependency, not vendored or merged into app code). See ADR 0045.
5. **S43-M5, display pairing limits.** A pairing code lasts 10 minutes. The display's claim window is 10 minutes after approval. At most 30 new codes per client address per hour. At most 10 wrong codes per manager per 15 minutes.
6. **S28b-L4, refunded redemption.** A refunded redemption still uses the reward's capacity (limits stay used).
7. **S28b-M2, personal points and rewards.** They send no notifications (ADR 0036).
8. **S29-L3, contributions per habit per day.** No cap.
9. **S23-L7, shared weekly chore overview.** Visible to all Home members by default.
10. **S38-L9, former-Home name snapshots.** Kept.
11. **S35-M1, photo upload limits.** 120 upload intents per hour and 25 pending uploads per account.
12. **S35-M5, thumbnail redirects.** Private cache of 30 seconds. Downloads and all other variants stay `no-store`. Revoking access to a thumbnail can lag by up to 30 seconds.

## Decisions implemented in code (PR #97, migration `20261213090000_review_decisions.sql`)

- **S41-M3:** a child whose only primary guardian is inactive or pending deletion is put on hold, with a warning; reactivation restores the role (`private.child_on_hold`, `my_guardian_hold_warnings`).
- **S41-M2:** changing a child's guardians needs fresh re-authentication (re-auth action `child_guardians`, 2-minute grant).
- **S15-M3:** the service-role client is limited to an allowlist, checked at compile time and run time (`apps/web/src/auth/service-role.ts`, with a test). See ADR 0019.
- **S16-4:** Home trash restore and purge are for the Owner and managers only (`can_see_trash_entry`). See ADR 0020.
- **S22-L3:** the auto-release timer restarts the day after the claimant's last vacation day (`chore_release_at`).
- **S34-M6:** conflicts on a calendar Google stops listing are kept and marked stale, with "Drop the conflict". See ADR 0044.
- **S38-M7:** purging account activity keeps `account_security_events`.
- **S29-L9:** a manager's correction of a contribution notifies the contributor (`habit.contribution_corrected`).
- **S30-L4:** only active goals count toward the 100-goal limit. See ADR 0038.
- **S25-L6:** destination Home names are hidden from origin managers who are not members ("Another Home").
- **S12b-L6:** members see the objection deadline.
- **S17-L9:** the widget picker shows a visual preview.
- **S35-L6:** photo storage figures are shown to all members; the storage page link stays for managers.

## Consequences

- The earlier ADRs listed under "Open" or "owner should confirm" for these items now point here.
- No schema change and no rollback are needed for this ADR.
