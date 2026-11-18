# ADR 0057: Household Display pairing and identity

- **Status:** Accepted, recording S43 as built (review backlog items S43-L12 and S43-M5). Within the approved architecture (§7, §33) and CLAUDE.md (authentication strategy A: "Children and Household Displays are also Supabase Auth users"; authorization strategy C). The limits and defaults below were confirmed by the owner on 17 November 2026 (ADR 0056, decision 12).
- **Date:** 2026-11-18 (S43 was built on 2026-11-12, PR #80)
- **Step:** S43 (brief: `plans/steps/S43-brief.md`). The display dashboard, per-device layout, privacy and party lock, member actions with PIN and Realtime are S44 and are not covered here.

## Context

A Household Display is a shared tablet on the wall. The spec requires a separate display identity that never acts as a member, paired only with a manager's approval, and revocable at once. S42 had already built the pattern this needs for children: a Supabase Auth user with an internal alias, a session issued only after Madeora's own check, and a request gate that limits what that session can call.

## Decision

**One migration,** `20261203090000_household_displays.sql`, adds `private.display_pairing_requests`, the display device records, the pairing, claim, heartbeat, rename and revoke functions and the request-gate rules. Tables have no grants; every call is a `security definer` function.

**Pairing request.** The unpaired screen at `/display` gets a random 32-byte claim secret in an httpOnly cookie (`madeora_display_pairing`, 30 minutes). The 8-character code (`XXXX-XXXX`, 31 letters and digits without 0, O, 1, I and L) is derived from that secret, so a refresh shows the same code without storing it. The database stores only SHA-256 hashes of the secret and of the code; the code hash is not salted (S43-L1, an accepted risk: an HMAC would need a new server secret).

**Approval binds everything at once.** A manager (the Owner, or an Administrator with `manageHomeSettings`) enters the code on `/homes/{id}/displays`, reviews the device and names it (1 to 40 visible characters). In one transaction, with the request row locked, the database checks that the request is pending and unexpired, that the code belongs to the request the manager reviewed, and that the caller is a manager now. It then creates the display's Supabase Auth user and the device record. A second manager finds it approved (`already_used`); the same manager retrying gets the same display back.

**Claim needs the tablet's secret, not the code.** Only the browser that showed the code can turn the approval into a session, once, within the claim window. Afterwards the secret is dead, so a replay gets nothing. Completing the claim does not set "last seen" (review S43-M3): a display that never sends a heartbeat stays listed as "not seen yet", and the manager can revoke it.

**Request gate.** `confirmed_email()` and `can_receive_notifications()` are null or false for a display, so the adult functions refuse it. The PostgREST pre-request check accepts a display token only for a registered, live session of an unrevoked display in an open Home, and only for `display_*` functions; tables, GraphQL and other functions answer `42501`. `auth.users` and `auth.identities` guards refuse a password, another email, a phone or a provider for a display. In the web app the token has its own kind, `display`, set by the database in `app_metadata.madeora_kind`; `getVerifiedIdentity` is null for it, so every adult API answers 401, and the `(auth)` pages send it to `/display`.

**Revocation** deletes the display's Supabase Auth user, so every session and refresh token goes at once; the device record stays as revoked and is listed for 30 days. A Home purge deletes displays too, and a Home pending deletion refuses display sessions at once.

## Limits and defaults (owner confirmed, ADR 0056 decision 12)

- A pairing code lasts 10 minutes; the claim window is 10 minutes after approval.
- At most 30 new codes per client address per hour (keyed by an HMAC of the address, never the address itself).
- At most 10 wrong codes per manager per 15 minutes, counted before the check; failed attempts are audited in the Home.
- At most 10 active displays per Home.
- A display session has no Madeora expiry: it lasts until it is revoked or reset, or the Home closes. Supabase's refresh-token rotation rotates the credential.
- The heartbeat runs every 60 seconds and updates "last seen" at most once a minute; a refused heartbeat sends the tablet back to the unpaired screen, and a network failure shows "offline".
- There is no unpair button on the display; managers revoke from their own session. An adult or child signed in on the tablet is asked to sign out before pairing.
- Audit events (never secrets or codes): `display.paired`, `display.pairing_failed` (with the reason), `display.renamed`, `display.revoked`, `display.signed_in`.

## Consequences

- QR scanning of the code is not built: it needs a new dependency and the owner's approval.
- The migration is listed in `docs/production-migrations.md`; the owner applies it to the hosted projects like any other.
- Rollback: drop the S43 objects. Display Auth users would have to be deleted with them; members' data is not touched.
