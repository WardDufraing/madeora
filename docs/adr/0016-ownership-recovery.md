# ADR 0016: Verified Home ownership recovery

- **Status:** Accepted for S12b within the approved architecture (§4, §5, §6, §8, §9, §43) and CLAUDE.md (authorization strategy C, database access strategy A). The owner chose to build recovery in S12 and to review requests on an in-app staff page (2026-10-15). The defaults listed below are open to correction by the owner.
- **Date:** 2026-10-15
- **Step:** S12b, follow-up to S12 (brief: `plans/steps/S12b-ownership-recovery-brief.md`). Builds on ADR 0014 (roles and ownership) and ADR 0015 (staff operations).

## Context

The spec's "Confirmed verified Home ownership recovery" covers a Home whose only Owner has permanently lost their account. Normal account recovery comes first. An eligible adult member may then ask for a review; being an Administrator, holding a device or a code, or claiming a relationship never authorizes a takeover by itself. The spec requires strong independent evidence, a visible pending state, a waiting and objection period, notifying the Owner, privacy-minimized alerts to members, cancellation by the Owner, pausing on dispute, rejection, an appeal path without automatic reversal, revalidation at commit, exactly one Owner at every moment, and a restricted audit.

## Decision

**Who decides.** Madeora staff (ADR 0015, architecture §43), never a Home member. The person who asks writes a private statement; staff verify identity and authority outside the app (for example a video call with ID) and record their reasons. There are no file uploads until file storage exists (S15).

**States.** `submitted` → `in_review` → `approved` (a 14-day objection period runs) → `ready` (period over) → `completed` once the person accepts. Other ends: `rejected`, `withdrawn` (by the person who asked), `cancelled` (by the Owner), `owner_returned`, `invalid` (a membership changed). `paused` holds a case after an objection or by staff, until staff resume it (an approved case then starts a fresh 14 days) or reject it.

**The Owner returning stops it.** A case stops as `owner_returned` as soon as the Owner signs in after the request (`auth.users.last_sign_in_at`) or opens the Home (reading the recovery status as Owner records `owner_seen_at`). The Owner's dashboard then shows who asked and "I still have access", which ends every open case as `cancelled`.

**Notifying.** The Owner is emailed at their confirmed address when staff start the review and whenever the case enters an objection period, from the staff decision endpoint. Not at submission: the request runs in the asking member's session, which must never handle the Owner's address. Other members see in the app only that a review is open, and can object; nobody but staff sees statements, objections or notes. Full notifications come with S14.

**Completion.** After the period the person who asked accepts in the app. Under the Home lock `accept_ownership_recovery` re-checks: the case is ready and not paused, the Owner is still the account the request was about and has not returned, the person is still an Administrator or Member with a confirmed account. It then demotes the Owner (to Member, or removes them when staff decided so), promotes the person, ends every other open case and, through the existing S12 trigger, any pending transfer, all in one transaction. The S09 index and deferred trigger still guarantee exactly one Owner; race tests cover acceptance against removal, the Owner returning, an ordinary transfer and an objection.

**Competing requests.** Several members may each have one open request; approving one rejects the others. A repeated request id returns the request it made.

**Appeal.** After completion the former Owner sees a notice on their personal dashboard and can appeal from Settings, even when removed from the Home. Staff close the appeal with a note; nothing is reversed automatically (a reversal, if warranted, is an ordinary ownership transfer).

**Data and access.** Cases, objections, appeals and staff lists live in `private` tables no API role can read. All access is through `security definer` functions executable by `authenticated` only, each re-checking the caller. API routes run the TypeScript permission engine first (`home.recovery.request`, `.cancel`, `.object`) and the function decides again. Staff endpoints answer 404 to non-staff and 401 `reauthenticate` unless the staff member's current session signed in within the last 15 minutes (checked on the session in the access token, so a sign-in on another device does not count). Staff never see or decide a request about a Home they belong to, or one they made or that is about them. Every transition, every staff read of a case and every staff decision is audited with ids only.

## Defaults chosen (owner may correct)

- A 14-day objection period after approval, restarted when a paused approved case resumes.
- Only Administrators and Members who joined at least 30 days ago, with a confirmed email, may ask.
- The former Owner stays as a Member by default; staff may decide removal when approving.
- One open request per person per Home; approving one rejects the others.
- The asking person sees their ended request for 30 days.

## Consequences

- The migration must be applied to `madeora-preview` and `madeora-production` by the owner (`docs/supabase-migrations.md`, check for S12b), after the architecture change in ADR 0015 is merged.
- Someone must be listed as staff in each project for requests to be reviewed (`docs/staff-operations.md`).
- Until two-factor sign-in exists (S37), a staff decision is protected by a recent sign-in only; the objection period, the Owner's cancel, the return check and acceptance by the person limit the damage of a compromised staff account.
- Rollback: `docs/supabase-migrations.md`, "If you need to undo S12b" (tested: it removes everything S12b added, including its audit entries, and the S12b file applies again afterwards).
