# S07 brief: personal context and preferences

- **Branch:** `feat/personal-preferences` (from `main` at `fd02a5d`)
- **Date:** 2026-10-14
- **Builds on:** S05 (shell, theme, languages; ADR 0006) and S06 (accounts; ADR 0007)

## Scope

1. **Personal context with zero Homes.** A confirmed adult lands on their personal dashboard. Nothing creates a Home or treats zero Homes as an error. The top bar keeps showing the **Personal** context.
2. **Starter personal dashboard shell.** A greeting (with the display name when there is one), today's date in the person's own formats and timezone, an honest empty widget area (widgets arrive with S17 and the modules), and a non-blocking **Create a Home** / **Join a Home** card next to the widget area, not inside it.
3. **Global preferences**, stored on the account and the same on every device:
   - **display name** (global, optional);
   - **interface language** (moves from a device cookie to the account);
   - **regional formats**: date display, 12/24-hour time, first day of the week, number separators, measurement units. Each one is **Automatic** or custom, with a live preview before saving;
   - **timezone**: automatic (this device's detected zone) or a chosen zone that applies on every device.

Spec: `docs/product/Project-specification.md` line 93 (Home-independent onboarding), 425 (starter personal dashboard), 444 (global display name), 611 (interface language), 622 (regional defaults), 631 (personal timezone). Architecture: §4 (`user_preferences`), §5 (API boundaries), §6 (database), §7 (sessions, CSRF), §9 (caching), §13 (forms), §14 (state), §18 (i18n), §19 (dates and timezones), §21, §25.

**Out of scope:** widgets and dashboard editing (S17), Homes and the context switcher with real Homes (S09), avatar and accent (S11), per-Home name overrides, Home scheduling timezone, Household Display settings, children, theme on the account (stays on the device; ADR 0006 left it open).

## Decisions

Defaults chosen from the spec and architecture where nothing more specific exists. The owner can change any of them; those marked **owner** need a yes before merge.

1. **One `public.user_preferences` row per account** (architecture §4), created on the first save. `null` means "not chosen" (language) or "Automatic" (formats, timezone), so returning to Automatic restores the current detected default and a custom choice is never reset by a device, language or Home change. RLS: each person reads, creates and changes only their own row; no one deletes it (it goes with the account, `on delete cascade`). Column grants keep `created_at`/`updated_at` out of reach. Check constraints mirror the app's validation.
2. **Writes go through `PATCH /api/v1/me/preferences`** (Route Handler, architecture §5): Zod-validated JSON, same-origin check (CSRF), JSON content type, identity confirmed with Supabase Auth, then an upsert with the person's own session so RLS applies. A stable HTTP contract later mobile clients can use. Reads happen on the server with the same session, cached for one request only.
3. **Language order:** account language → device cookie `md-locale` → `Accept-Language` → English. Saving the language also writes the device cookie, so sign-in pages on that device follow it. Accounts that never chose keep today's behaviour.
4. **Regional options:** date `31/12/2026`, `31-12-2026`, `31.12.2026`, `12/31/2026`, `2026-12-31`; time 24-hour or 12-hour; week starts Monday, Saturday or Sunday; numbers `1,234.5`, `1.234,5`, `1 234,5`; units metric or US customary. **Automatic** is derived on the server from the browser's preferred regional language tag (first `Accept-Language` entry, e.g. `nl-BE`) using `Intl`; when that is missing, from the interface language. Never stored, recomputed per request, so the server and browser render the same.
5. **Timezone:** automatic = the zone the browser reports (`Intl`), kept per device in the cookie `md-timezone` and refreshed when the device's zone changes (travel), without rewriting anything. A chosen zone is stored on the account and wins on every device until the person returns to Automatic. Before a device has reported its zone, UTC is used and labelled as such. Zones are validated with `Intl` on the server. No new dependency: `date-fns`/`date-fns-tz` are approved but not needed until date arithmetic arrives.
6. **Display name:** optional; 1–50 characters after trimming, Unicode NFC, no control characters (**owner:** confirm the 50-character limit). No default taken from the email address. User-written text: never translated, isolated for mixed-direction text (Unicode isolates, the plain-text form of `<bdi>`).
7. **Create a Home / Join a Home** link to `/homes/new` and `/homes/join`, which say honestly that this part is not built yet (Home creation is S09, joining later). Nothing is created. The card stays visible and never blocks or nags (**owner:** confirm placeholder pages are acceptable until S09).
8. **Migrations to hosted projects (owner):** this is the first step with an app table, so ADR 0007's "the first step that adds app tables also adds the way migrations reach this project" lands here. Proposal: the owner applies each migration file in the Supabase SQL Editor of `madeora-preview` (before testing the PR preview) and `madeora-production` (before the release PR), following a numbered guide in `docs/supabase-migrations.md`, with a check query. No database secret goes into GitHub or Vercel (€0, no new access). Recorded in ADR 0009. If the table is missing, the app still renders with device defaults, and the settings page says preferences could not be loaded.

## Done when

- A newly registered, confirmed adult lands on the personal dashboard with zero Homes: Personal context, starter dashboard shell, Create a Home / Join a Home visible and non-blocking (E2E).
- Changing display name, language, each regional format and the timezone persists, still applies after a reload and on another signed-in device; Automatic restores the detected value (E2E plus unit tests).
- RLS: another account cannot read, create or change someone's preferences; signed-out visitors get nothing; invalid values are refused by the database (SQL RLS tests).
- Format, lint, typecheck, unit tests, build, database tests and E2E pass; independent review returns PASS with no open BLOCKER or HIGH; review saved in `reviews/steps/S07-review.md`.

## Tests

- **Unit:** regional detection and formatting (several locales), timezone validation, preference schema, locale precedence, effective timezone, route handler (CSRF, content type, size, unauthenticated, invalid input, success, database failure).
- **Component:** settings forms (display name, language, regional preview and Automatic/Custom, timezone), dashboard page, axe.
- **Database:** `tests/db/rls/user_preferences.test.sql` with two users, anon and the service role; constraints; column grants.
- **E2E** (fresh accounts, so the shared account's language never changes under other tests): new adult on the dashboard; each preference saved, reloaded and seen from a second browser context; automatic timezone from an emulated device zone; axe on dashboard and settings.

## Risks

- Every signed-in page now reads one row (cached per request). A failed read falls back to device defaults instead of failing the page.
- A person can write their own row directly through the Data API, bypassing the route's Zod checks; database constraints keep values well-formed and readers ignore anything they do not recognise. Only their own row is affected.
- Detection from `Accept-Language` is a best guess (Chrome often sends `en-US` for non-US users); the person can override every setting.
