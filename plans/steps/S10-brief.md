# S10 · Invitations and join requests — feature brief

**Branch:** `feat/home-invitations`, from `main` at `d56924f` (S09 merged).
**Sources:** build plan S10 and its "Done when"; PS "Confirmed Home invitations" and the sections after it up to "Confirmed email invitation account matching" (L226–L269); PS "Confirmed private accounts and invitation-only discovery" (L554–L560); PS onboarding (L94–L97) for "Join a Home"; PS L391–L398 (customizable Administrator permissions, for the engine's shape); Project-entry journey "Join Home"; ARCH §4, §7, §21; CLAUDE.md email strategy A, authorization C, forms A; carry-overs from S08 (production sign-up closed until S10) and S09 (review L3, L7).

## The flows (spec option B, 13 Oct: approval is the membership boundary)

1. **Email invitation** (recipient-bound): a manager enters an email address, a role (Member by default, Administrator only if allowed) and the email's language. Madeora sends an email with a link. Only a signed-in account whose **verified** email is exactly that address can accept. Expires after **7 days** (not configurable: the spec leaves that open). Single use.
2. **Invitation link** (account-independent): role, expiry 24 h / **7 days** / 30 days, single use (default) or multi-use with a cap of 2–10 successful admissions. The manager copies and shares it.
3. **Join code** (join-request link/code, distinct wording): Member role only, expiry 24 h / **7 days** / 30 days, no use cap, shown as a 10-character code (`XXXXX-XXXXX`) and as a link.

In every flow the person must be signed in, sees only the Home's name and the proposed role, and presses an explicit button. That creates a **pending join request**; a manager then **approves** (membership created) or **declines**. The applicant can **withdraw** while pending. Opening a link, signing in, sending a request or being declined never consumes a use; only an approval does, atomically.

## Actors and permissions

- **Invitation managers** (`home.invitations.manage`): the Owner. An Administrator gets this through the delegable capability `manageInvitations`, which the Owner can grant from S12 (until then Administrators have none). Covers: list invitations and requests, create Member invitations, links and join codes, copy links, revoke, resend, renew, approve or decline Member requests.
- **Administrator invitations and approvals** (`home.invitations.manageAdministrators`): Owner only, never delegable (spec: assigning Administrators is an Owner-only power).
- **Members:** none of the above; they never see recipient emails or requests.
- **Applicant** (any signed-in adult with a confirmed email): preview a valid invitation, request to join, see and withdraw their own requests.
- **Anyone signed out:** a join link sends them to sign-in first; nothing about the Home is shown.
- At acceptance and at approval the database re-checks: the inviter still has the authority for that role (else the invitation is no longer valid), the approver's current authority, the invitation (not revoked, not expired, uses left), the applicant's confirmed email (and exact match for email invitations), and existing membership.

## Design

1. **Database** (one migration), all in schema `private` (never reachable through the Data API); the API only calls reviewed `security definer` functions in `public`:
   - `private.home_invitations`: Home, kind (`email` / `link` / `join_code`), role (`member` / `administrator`; join codes Member only; never Owner), recipient email (email kind, lower case) and email language, expiry, max admissions (1 for email, 1 or 2–10 for links, none for codes), admissions so far, creator, creation request id (double-submit safety), the current token (random, 256-bit for links and emails, 50-bit Crockford code for join codes; unique), end state (revoked / declined, by whom, when), email send bookkeeping (last sent, sends in the current 24 h window, delivery status).
   - `private.home_join_requests`: Home, invitation, applicant, role (copied from the invitation, never chosen by the applicant), status (pending / approved / declined / withdrawn / expired), the applicant's verified email and display name at request time (what managers see), decided by and when. One pending request per person per Home.
   - `private.join_attempts`: failed token or code lookups per account, for rate limiting.
   - **Functions** (granted to `authenticated` only): `create_home_invitation`, `list_home_invitations`, `revoke_home_invitation`, `prepare_home_invitation_email` (for resend, with rate limit), `renew_home_invitation`, `record_home_invitation_delivery`, `preview_home_invitation`, `request_to_join_home`, `list_my_join_requests`, `withdraw_join_request`, `list_home_join_requests`, `decide_join_request`. Authority lives in one SQL helper (`private.can_manage_invitations(home, user, role)`), mirrored by the TypeScript engine.
   - **25 active invitations per Home**, counted under a row lock on the Home, so simultaneous creations cannot exceed it. Active = not ended, not expired, and uses left. Renewal replaces the link on the same record (old link dead at once), so it can never make two.
   - **Approval** locks the request and the invitation row, re-checks everything above, inserts the membership (the S09 audit trigger records it with the approver as actor), counts the use and records the decision. Two managers approving at once, or two requests racing for the last use, serialise on those locks; the loser gets "no longer valid" or "already decided".
   - **Audit:** invitation created, revoked, resent, renewed; request created, withdrawn, approved, declined, expired. Details hold kinds, roles and choices, never email addresses or names.
2. **No account enumeration:** creating an email invitation never looks up accounts, so the answer, its timing and its delivery are the same for any address. Preview and acceptance never show the invited address. "Already a member" is only ever shown to the person themselves.
3. **Abuse limits (defaults):** 10 failed link/code lookups per account per 15 minutes; 20 new join requests per account per 24 hours; one pending request per Home; a declined person cannot request again with the same invitation; email resend at most once a minute and 5 times per 24 h per invitation (renewal counts as a send); 25 active invitations per Home.
4. **Email** (`packages/email`, React Email): one template, "You're invited to join {Home} on Madeora", in English and Dutch, HTML and plain text, the role, the expiry and the link; no inviter name or other Home data. Sent from the server only, with an idempotency key. Transports: **Resend** (HTTP API) for hosted environments; **Mailpit** (the local mail catcher) for development and tests only; **off** when not configured, in which case email invitations say "email isn't set up here" and links and codes still work. Delivery is synchronous until background jobs exist (S13); a failed send is shown on the invitation with Resend as the fix, never hidden.
5. **Server API** (`/api/v1`, same CSRF, JSON and size checks as S09; verified identity; Zod; engine; then the function with the person's own session):
   - `POST /homes/{homeId}/invitations` (create; sends the email for the email kind)
   - `POST /homes/{homeId}/invitations/{id}/revoke`, `/resend`, `/renew`
   - `POST /homes/{homeId}/join-requests/{id}/decision` `{ decision: "approve" | "decline" }`
   - `POST /join-requests` `{ token }` (request to join), `POST /join-requests/{id}/withdraw`
6. **Pages:**
   - `/homes/[homeId]/invitations` ("Invite people", managers only; others get the neutral not-available notice): requests waiting for approval (name, verified email, role, how they came, when; Approve / Decline), the create form (radio: email invitation / invitation link / join code, with the fields above and the chosen expiry shown before creating), and the invitation list with status (Active, Expired, Revoked, Declined, Used up, Accepted), expiry, "2 of 5 used, 3 left", delivery status, and actions Copy link, Resend, Renew (confirmation shows the new expiry), Revoke (confirmation). Limit-reached state with a pointer to revoke.
   - Home dashboard: managers see an "Invite people" link with the number of pending requests.
   - `/join/[token]`: signed-in preview: Home name, proposed role, kind-specific wording ("You're invited to join" / "Ask to join"), expiry, "A manager approves your request before you become a member", and the button. States: invalid, expired, revoked, used up, wrong email (without showing the address, with sign-out-and-switch and "ask for a new invitation" hints), already a member (link to the Home), request pending (link to your requests), declined, too many attempts.
   - `/homes/join` (replaces the S07 placeholder): enter a join code, and "Your join requests" with Pending / Approved / Declined / Expired / Withdrawn and Withdraw.
   - The context switcher gains "Join a Home".
7. **Sign-up while invited:** a signed-out visitor goes to sign-in with the join page as `next`; new people use "Create an account" and open the invitation link again after confirming (carrying the destination through the confirmation email would need extra Supabase redirect entries; not now).

## Tests

- **Unit:** engine matrix with the new actions and capability; schemas (each kind, cap range, expiry choices, roles, emails); join-code normalisation (case, dashes, spaces, Crockford look-alikes); email template (both languages, HTML and text, escaping of the Home name); transports (Resend headers and idempotency key, Mailpit, error mapping, nothing personal logged); env schema (transport rules per environment, key shapes); every API route (CSRF, content type, size, unauthenticated, invalid, not found, not permitted, each outcome, identical answers for any email address); components with axe in both languages.
- **Database** (`tests/db/rls/invitations.test.sql`): tables and token unreachable through the API; only the Owner creates, lists, revokes, renews, resends, decides; Member and outsider refused; Administrator role invitations and approvals Owner-only; cap range, expiry choices, Owner role and Administrator join codes refused; 25-limit (ended invitations do not count; renewal does not add); idempotent creation; preview states; email mismatch and unverified email refused; requests: one pending per Home, role copied, withdraw only by the applicant, decline blocks re-request via that invitation; approval re-checks expiry, revocation, cap, inviter authority, applicant email, existing membership; single-use and multi-use consumed only by approvals; capacity exhaustion; Home deleted during pending; rate limits; audit rows without emails or names. A separate two-connection test proves simultaneous approvals and simultaneous creations at the limit cannot exceed caps.
- **Playwright ("Join Home" journey):** Owner sends an email invitation → the invitee (new account) opens the email link, signs in, sees Home and role, accepts → pending → Owner approves → the invitee switches into the Home as Member. Multi-use link with cap 2: two people approved, the third sees "used up". Join code typed on `/homes/join` → Owner declines → applicant sees Declined. Expired and revoked invitations show their states and cannot be accepted. Withdraw. A forwarded email invitation opened by another account is refused. Renew kills the old link. The create answer is identical for an existing and an unknown address. Keyboard-only and axe in both themes on the new pages.

## Out of scope (later steps)

Granting `manageInvitations` to Administrators (S12); member directory and the effective-permissions overview (S11); in-app notifications to managers and applicants (S14; managers see the pending count on the Home dashboard meanwhile); moving email delivery to background jobs with an outbox (S13); invitation invalidation on Home deletion (S40; Home deletion already removes everything with it); reissuing expired or revoked email invitations (spec: "to be specified separately"; create a new one); children and displays (S41–S44); retention of declined/withdrawn requests (open in the spec).

## Defaults picked (owner may override)

- Only the Owner manages invitations until S12; inviting or approving Administrators stays Owner-only.
- Email invitations expire after 7 days and are single use; links and codes default to 7 days.
- Join codes have no use cap (only expiry and revocation).
- An email invitation still counts toward the 25 while its recipient's request is pending; a decline ends it.
- Managers see the applicant's display name (if set) and verified email.
- Abuse limits as in Design 3.
- The email's language is chosen by the inviter (default: their own language).
- The invitation email names the Home and role, not the inviter.
- Production sign-up stays closed (see open question).

## Sending domain (Ward, 14 Oct)

- The project owns **`madeora.studio`** (already the production address). Email is sent from the subdomain **`mail.madeora.studio`**, verified in Resend (free plan: one domain, shared by previews and production, with separate API keys and sender names). Owner guide: `wip/S10/resend-domain-setup.md`, later `docs/email-setup.md`. Senders: `Madeora <no-reply@mail.madeora.studio>` (production), `Madeora Preview <no-reply@mail.madeora.studio>` (previews).

## Open question for the owner

- **Production sign-up.** With the domain verified, email reaches anyone, so the technical reason for keeping it closed is gone. What remains is ADR 0008's "demo data only until the privacy position is settled (S49)". Default: keep it closed in S10 (accounts on production are still created by Ward), unless Ward chooses to open it.

## Acceptance tests (done when)

1. The "Join Home" journey passes end to end, including expired and revoked invites.
2. No response reveals whether an email has an account.
3. Format, lint, typecheck, unit tests, build, database tests and E2E pass.

**Decision (Ward, 14 Oct, decision card):** open production sign-up with S10. Recorded in ADR 0012; owner switches it on in Supabase after the domain is verified and S10 is released (`docs/email-setup.md` step 8). CLAUDE.md's "demo data only" line needs its own owner-approved PR.
