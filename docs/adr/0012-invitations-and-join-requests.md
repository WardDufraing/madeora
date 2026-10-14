# ADR 0012: Invitations, join requests and transactional email

- **Status:** Accepted for S10 within the approved architecture and CLAUDE.md (authorization strategy C, transactional email strategy A). Defaults chosen without asking, listed below, are open to correction by the owner.
- **Date:** 2026-10-14
- **Step:** S10, invitations and join requests (brief: `plans/steps/S10-brief.md`)

## Context

People join a Home by email invitation, invitation link or join code, and a manager approves every request before it becomes a membership (spec: "Confirmed email invitations", "Confirmed link and code invitations", "Confirmed manager approval of join requests", "Confirmed active invitation management", "Confirmed email invitation resend and renewal"). No answer may reveal whether an email address has a Madeora account. This is the first feature that sends the app's own email; CLAUDE.md fixes Resend with React Email, from server code only.

## Decision

**Data.** `private.home_invitations`, `private.home_join_requests` and `private.join_attempts` live in schema `private`, so the Data API cannot reach them or their tokens. Every read and write goes through `security definer` functions (empty `search_path`, execute granted to `authenticated` only) that check the caller's confirmed account, current membership and authority each time. `private.can_manage_invitations(home, user, role)` is the one SQL authority rule, mirrored by the TypeScript engine actions `home.invitations.manage` (Owner; Administrators through the delegable capability `manageInvitations`, granted from S12) and `home.invitations.manageAdministrators` (Owner only, never delegable).

**Secrets.** Email invitations and links carry a 256-bit random token (43 base64url characters); join codes are 10 Crockford base32 characters, shown as `ABCDE-FGHJK`. Codes are normalized in SQL (case, spaces, dashes, I/L→1, O→0). The token is only returned to managers for active links and codes, never for email invitations.

**Flow.** Using a link or code only creates a pending join request with the invitation's role; nothing is consumed and no access is granted. Approval is the membership boundary: `decide_join_request` locks the request and then the invitation, re-checks expiry, revocation, uses left, the inviter's authority, the applicant's verified email (email invitations) and existing membership, then creates exactly one membership. Single- and multi-use invitations are consumed only by approvals. A declined person cannot ask again with the same invitation. An email invitation works only for an account whose confirmed email is the invited address.

**Limits.** 25 active invitations per Home, counted under a per-Home advisory lock so simultaneous creations cannot pass it; ended invitations do not count, and renewal replaces the link on the same record. Per account: 10 failed link or code lookups per 15 minutes and 20 new requests per 24 hours. Per email invitation: one send a minute and 5 per 24 hours (creation, resend and renewal all count). Invitation emails per sending account and per Home: 20 per 24 hours, counted in `private.invitation_email_sends`, so revoking and inviting again cannot get around it; this stays well under Resend's free 100 emails a day, which Supabase Auth's account emails share. A pending request whose invitation ended before anyone decided is closed as expired when the applicant next uses a link or code for that Home, so it never blocks a new invitation. A request id reused with other content is refused. A two-connection test proves the limit and single-use approvals hold under concurrency.

**Email.** `packages/email` holds one React Email template ("You're invited to join {Home} on Madeora", English and Dutch, HTML and plain text, role, expiry in the Home's timezone and the link; no inviter name) and two transports: Resend's HTTP API with an idempotency key, and the local Mailpit catcher for development and tests (refused in any other environment). `EMAIL_TRANSPORT` (`resend`, `mailpit` or `off`), `EMAIL_FROM`, `RESEND_API_KEY` and `MAILPIT_URL` are validated in `packages/config`; without a transport, email invitations are not offered and links and codes still work. Sending is synchronous until background jobs exist (S13): the outcome is recorded on the invitation and shown to the manager, who can resend. Logs name the outcome only, never the address, the Home or the link. Sending domain: `mail.madeora.studio`, shared by previews and production with separate API keys and sender names (owner guide: `docs/email-setup.md`).

**API.** `POST /api/v1/homes/{homeId}/invitations`, `.../invitations/{id}/revoke|resend|renew`, `.../join-requests/{id}/decision`, `POST /api/v1/join-requests` and `.../join-requests/{id}/withdraw`, all with the shared same-origin, JSON and size checks. The create answer has the same shape and status for any address. Creation is idempotent per request id.

**Pages.** `/homes/{homeId}/invitations` (managers; others get a neutral notice), `/join/{token}` (signed-in preview with a generic page title; signed-out visitors sign in first and come back), and `/homes/join` (enter a join code; your own requests with Withdraw). The Home dashboard links managers to the invitation page with the number of waiting requests; the context switcher gains Join a Home.

## Defaults chosen (owner may correct)

Only the Owner manages invitations until S12; Administrator invitations stay Owner-only; email invitations last 7 days and admit one person; links last 24 hours, 7 days or 30 days and admit 1 or 2 to 10 people; join codes are for Members only with no cap; managers see the applicant's display name and verified email; the inviter chooses the email language; the email names no inviter; the abuse limits above.

## Production sign-up (owner decision)

Ward chose on 14 October 2026 to open production sign-up to everyone with S10, replacing ADR 0008's "closed until S10" default. It is one Supabase setting, switched on by the owner after the sending domain is verified and the S10 release is live (`docs/email-setup.md`, step 8), so confirmation emails reach new people. Turnstile stays on every sign-in form. Consequence the owner accepted: real people's accounts and data can land in production before the privacy position of S49 is settled. `CLAUDE.md` still says early production holds "demo data only"; that line changes only through its own owner-approved pull request.

## Consequences

- The migration must be applied to `madeora-preview` and `madeora-production` by the owner (`docs/supabase-migrations.md`).
- Hosted environments need `EMAIL_TRANSPORT`, `EMAIL_FROM` and `RESEND_API_KEY` in Vercel before email invitations are offered there (`docs/email-setup.md`); until then links and codes work.
- A send that fails is shown, not retried in the background, until S13 adds durable jobs.
- Rollback is dropping the new tables and functions and restoring the previous audit subject check; memberships created by approvals stay valid.
