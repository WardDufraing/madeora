# S12b: Verified Home ownership recovery (follow-up to S12)

Ward chose on 2026-10-15 to build verified ownership recovery as part of S12 rather than as a later step. S12 (PR #19) was already merged, so this is a follow-up change on branch `feat/ownership-recovery`.

Spec: `docs/product/Project-specification.md` lines 285–300 ("Confirmed exactly one Home Owner", "Confirmed verified Home ownership recovery"). Builds on ADR 0014.

## What the spec requires (summary)

- Standard account recovery comes first. Recovery is for a sole Owner whose account is genuinely unrecoverable.
- An eligible, verified adult member may request review. Being an Administrator, holding a device, a join code or a claimed relationship never authorizes takeover on its own.
- Strong independent evidence (identity, current membership, loss of Owner access, legitimate authority). Never only email access, household knowledge, a single code or self-attestation.
- A visible pending state; a meaningful waiting/objection period before any transfer; notify the Owner through verified channels; alert adult members with privacy-minimized details; cancellation by the Owner, dispute, investigation, rejection and appeal. Never expose evidence to other members.
- Dispute, suspected compromise or contradictory evidence pauses the case.
- Completion: explicit approval through the verified process plus acceptance by the recipient; revalidate everything at commit; atomic, exactly one Owner at every moment; the former Owner's other Homes and account are untouched.
- The Owner regaining access suspends or cancels the case. After completion, a protected appeal path without automatic reversal. Restricted audit of evidence, decisions and transitions.

## Design

1. **Who verifies.** A Madeora-side reviewer (Ward), not any Home member. Recommended mechanism (decision card): reviewer-only SQL functions in the `private` schema, run by Ward in the Supabase SQL Editor of the project concerned, with a step-by-step guide. No staff accounts, staff UI or new service (€0, no architecture change). Alternative: an in-app review page for an allowlisted operator account (a new staff role: architecture change, needs its own ADR and approval).
2. **Evidence.** The claimant submits a private written statement (why the Owner is unreachable, what they tried, how the reviewer can verify them). The reviewer verifies identity and authority outside the app (for example a call with ID shown) and records a rationale. No file uploads until file storage (R2, S15) exists; nothing about the case is shown to other members except that a review is open.
3. **Case states.** `submitted` → `approved` (waiting/objection period running) → `ready` (period over, waiting for the claimant to accept) → `completed`; or `rejected`, `withdrawn` (by the claimant), `cancelled` (by the Owner), `paused` (objection or reviewer), `owner_returned` (the Owner signed in after the request).
4. **Waiting/objection period:** 14 days after reviewer approval (default; the spec leaves the length open).
5. **The Owner returning.** If the Owner has signed in after the request was made, approval and completion are refused and the case moves to `owner_returned` (checked in the database against `auth.users.last_sign_in_at`). The Owner's dashboard shows the open case with "I still have access: cancel this request".
6. **Notifications.** Email to the Owner's verified address when a case is submitted and when it is approved (Resend, existing `packages/email`). Other adult members see an in-app notice on the Home dashboard ("An ownership review is open for this Home"), with Object. Full notifications arrive with S14.
7. **Objection.** Any current adult member, or the Owner, can object while a case is open; the case pauses until the reviewer resumes or rejects it. The objection text is private to the reviewer.
8. **Completion.** After the period, the claimant accepts in the app. Under the Home lock the database re-checks: case `ready`, still not paused, claimant still a member, Owner still the same and not returned since the request. It then demotes the Owner to Member (or removes them if the reviewer decided so) and promotes the claimant in one transaction. Other pending transfers and cases for the Home end.
9. **Appeal.** After completion the former Owner can file an appeal from their personal dashboard (or, if removed, from Settings); it is recorded for the reviewer and changes nothing automatically.
10. **Audit.** Every transition is audited with ids only; statements, objections and rationale live in private tables readable by no API role.

## Tests

DB matrix (eligibility, strangers, children/displays n/a yet, competing claimants, owner objects, owner returns before commit, concurrent transfer/removal, atomic handover, failed approval, privacy of evidence), a concurrency test (completion vs removal/transfer), unit and component tests, one Playwright journey (request → reviewer approves via SQL in the test → objection pauses → resume → accept), and the guide's reviewer steps.

## Defaults picked (owner may override)

- 14-day objection period after approval.
- Former Owner becomes a Member by default; the reviewer may decide removal.
- Only Administrators and Members who have been members for at least 30 days may request (a young membership is weak evidence of authority).
- One open case per claimant per Home; several claimants may have open cases; approving one rejects the others.

## Open decision for Ward

- How the reviewer works: SQL functions in the Supabase SQL Editor (recommended) or an in-app staff page.
