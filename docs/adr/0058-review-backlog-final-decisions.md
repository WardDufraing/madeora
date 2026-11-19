# ADR 0058: Review backlog final decisions

- **Status:** Accepted. Records the last answers the owner gave to open questions from the review backlog (`plans/steps/fix-review-backlog-brief.md`, decisions log, rows 24 to 31). Follows ADR 0056.
- **Date:** 2026-11-19
- **Decided by:** Ward.

## Context

Parts 5 to 9 of the review backlog left a few findings open because they needed an owner choice. Ward answered them one by one. Six answers keep the behaviour as built. Two asked for a change, made in migration `20261218090000_review_decisions_final.sql`.

## Decisions accepted as built

1. **S43-L1, pairing code hash (row 24).** The Household Display pairing code stays stored as an unsalted hash, with no server secret. Accepted because a code lives only 10 minutes and the pairing rate limits apply (ADR 0056, item 5; ADR 0057).
2. **S15-L5, avatar cache and revocation (row 25).** Avatar views keep their current short, private handling: each view is authorized again and redirects to a 60-second GET-only link, with `private, no-store` (`/api/v1/files/[fileId]/content`). No longer browser cache is added. Leaving a Home or changing an avatar takes effect at once; a link already issued works for at most 60 seconds. The cost is that avatars are loaded again on each view.
3. **S23-L5, former members and Home notifications (row 27).** A person who has left a Home gets no notifications about it, in-app or by email. This is intended.
4. **S38-L12, sign-in alerts for child and Display accounts (row 29).** New-sign-in alerts are for adult accounts only. Child and Household Display sign-ins send no alerts, to the account or to guardians.
5. **S28b-L2, points balance cap (row 30).** There is no cap on a points balance.
6. **S26-L5, restore when a rule already made a new item (row 31).** Restoring an item while its recurring rule has already made a new one is allowed, so a rule can have two active items.

## Decisions implemented in code (migration `20261218090000_review_decisions_final.sql`)

- **Row 26, a primary guardian who returns after a new primary guardian was appointed.** While a primary guardian is deactivated or pending deletion, the Owner may appoint a new primary guardian (S41-M3, ADR 0056). When the old primary guardian comes back, they are the child's secondary guardian, and the new primary guardian stays primary. `private.apply_child_guardian` keeps their row as secondary at the appointment. While they are ineligible the row gives them no authority (`private.child_guardian_role`). If another secondary guardian holds the place, that guardian stays and the returning guardian gets no role, because a child has at most one secondary guardian.
- **Row 28, S38-L8, an unknown time zone on the activity pages.** A security report requested in a time zone the database does not know (the browser's ICU list and `pg_timezone_names` can differ) falls back to UTC instead of failing. The report then says UTC. One day of slack is allowed at each end of the range, and the range is clamped to what UTC allows. The pages already fall back to UTC when the person's own zone is unusable (`resolveTimeZone`).

## Consequences

- The review backlog has no open owner decisions left.
- Rollback for the two code changes: re-apply `private.apply_child_guardian` from `20261213090000_review_decisions.sql` and `public.request_security_report` from `20261212090000_review_backlog_api_jobs_perf.sql`. No table or column changes.
