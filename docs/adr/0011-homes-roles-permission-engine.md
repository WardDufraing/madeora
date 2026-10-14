# ADR 0011: Homes, roles and the permission engine

- **Status:** Accepted for S09 within the approved architecture (§4, §5, §6, §8) and CLAUDE.md (approved authorization strategy C). Defaults chosen without asking, listed below, are open to correction by the owner.
- **Date:** 2026-10-14
- **Step:** S09, Homes, roles and the permission engine (brief: `plans/steps/S09-brief.md`)

## Context

An adult may belong to several Homes with a different role in each, and keeps a Personal context that is separate from all of them (spec: "Confirmed explicit multi-Home switching", "Confirmed Home-independent adult account onboarding"). Every Home has exactly one Owner. CLAUDE.md requires Home isolation in PostgreSQL RLS plus one centralized, typed TypeScript permission engine for detailed decisions, and multi-actor tests for cross-Home access, forged IDs, role escalation and revocation.

## Decision

**Tables.** `public.homes` (name, timezone, creator, creation request id) and `public.home_memberships` (Home, account, role `owner` / `administrator` / `member`, one row per account per Home). Both have RLS. A person reads only the Homes they belong to now and, for now, only their own membership rows (the member directory is S11). Only an Owner changes a Home's name and timezone, and only those two columns are writable. Nobody writes memberships through the Data API: they change only through reviewed functions (`create_home` now; invitations and role changes in S10 and S11).

**Exactly one Owner.** A partial unique index allows at most one Owner row per Home, and deferred constraint triggers refuse to end a transaction where a Home has none (so removing, demoting or deleting the account of the sole Owner fails; ownership transfer arrives later). Account deletion of a sole Owner is therefore refused rather than leaving an ownerless Home.

**Creating a Home** is `public.create_home(name, timezone, request_id)`, a `security definer` function (empty `search_path`) that creates the Home and the Owner membership atomically for a signed-in, confirmed account. The request id is unique per creator, so a retry or double submit returns the same Home. Execute is granted to `authenticated` only.

**Audit.** Triggers write Home creation, settings changes and membership creation, role change and end into `private.audit_events` (not exposed through the API), with the actor, Home and a small details object that never holds names or other personal content.

**Name policy.** Home names are 1 to 50 characters (code points) after NFC normalization and trimming, with at least one visible letter, number, symbol or punctuation mark, no controls, no invisible or direction-changing format characters, joiners and variation selectors only where they attach to visible characters, tag characters only in complete emoji flags. This is the stricter policy that S07's review deferred. The database enforces it with a check (it can only list code points) and the app with `src/names/visible-name.ts`; both change together. Display names and nicknames switch to the same policy in S11, when other members first see them.

**The engine** (`packages/domain`, `@madeora/domain/permissions`) is pure TypeScript with no framework imports. `decideHomeAction(homeId, membership | null, action)` answers allowed or refused with a reason (`not-member`, `not-permitted`); a role never crosses Homes. Owners can do everything; Administrators and Members can view; an Administrator gains an action only through a delegated capability (`manageHomeSettings`), which no screen grants yet (S12). `homePermissions` projects the same answers for the UI, which only uses them to decide what to show. The server calls the engine for every Home action and RLS refuses the same actions directly, so neither layer is the only guard. A policy matrix test fails when a role, action or capability is added without a row.

**API.** `POST /api/v1/homes` and `PATCH /api/v1/homes/{homeId}` share `src/api/json-request.ts` (same-origin check, JSON only, size limit) with the preferences route. A Home the caller does not belong to answers `404` whether or not it exists; a member without the right answers `403`.

**Context is the URL.** `/homes/{homeId}/...` is a Home, anything else is Personal, so two tabs can be in different Homes. The switcher in the top bar lists Personal, the Homes the person belongs to now with their role, and Create a Home. Every Home page re-checks the membership on the server; a Home that is gone, never joined or foreign shows one neutral notice in Personal. The last context is remembered per device in the cookie `md-context` (`{userId}.{homeId|personal}`, ignored for another account), only to choose where `/` lands; it grants nothing.

## Defaults chosen (owner may correct)

Home name 1 to 50 characters; no limit on the number of Homes per person; the last context is remembered per device; Administrators get no capabilities until S12; Members see only their own membership until S11; a sole Owner cannot delete their account.

## Consequences

- Home pages read the membership and Home on each request; there is no cross-request cache of personalized data.
- The database name check is slightly more lenient than the TypeScript policy for lone combining marks of rarer scripts; the app rejects them first.
- Browser tests that need membership in someone else's Home set it up directly in the throwaway test database (`tests/e2e/support/database.ts`, `E2E_DATABASE_URL`), because invitations arrive with S10.
- The migration is additive. Rollback is dropping the new tables and functions; it contains no data worth keeping before real use.
