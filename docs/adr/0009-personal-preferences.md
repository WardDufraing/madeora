# ADR 0009: Personal context and global preferences

- **Status:** Accepted for S07 within the approved architecture (§4, §5, §6, §7, §9, §13, §14, §18, §19). Owner approved on 2026-10-14: the 50-character display-name limit, the placeholder Home pages until S09, the SQL Editor procedure for migrations on the hosted projects, and deferring a fuller invisible-character policy for display names to S09/S11.
- **Date:** 2026-10-14
- **Step:** S07, personal context and preferences (brief: `plans/steps/S07-brief.md`)

## Context

The specification lets an adult use Madeora with zero Homes: register, land on a personal dashboard, and create or join a Home later, without being blocked or nagged ("Confirmed Home-independent adult account onboarding", "Confirmed editable starter personal dashboard"). Each adult has a global display name ("Confirmed global adult avatar and display name"), their own interface language across Homes, regional formats that are Automatic or individually overridden, and a timezone that follows the device unless they choose one ("Confirmed individual interface language", "Confirmed automatic regional defaults", "Confirmed personal timezone detection"). ADR 0006 kept the language on the device until accounts could hold it. ADR 0007 said the first step with app tables decides how migrations reach the hosted projects. S07 is that step.

## Decision

**Storage.** `public.user_preferences`, one row per account (architecture §4), created by the first save, deleted with the account. `NULL` means "not chosen" for the language and "Automatic" for each format and the timezone, so Automatic always means the current detected value and no device, language or Home change can reset a custom choice. RLS lets each person read, create and change only their own row; nobody deletes one through the API. Column grants keep `created_at` and `updated_at` (set by a trigger) out of reach. Check constraints mirror the app's allow-lists, so writes made directly through the Data API stay well-formed; readers still treat unknown values as not chosen.

**Writes** go through `PATCH /api/v1/me/preferences`, a versioned Route Handler (architecture §5): same-origin check (CSRF), JSON only (a cross-site form cannot send it), 4 KB limit, identity confirmed with Supabase Auth, Zod validation with the schema the forms use (`src/preferences/schema.ts`), then an upsert with the person's own session, so RLS applies. Saves share one TanStack Query mutation scope, so they reach the server in order, and then refresh the server-rendered page. **Reads** happen on the server with the same session, cached for one request (React `cache`); a failed read falls back to the defaults, and the settings page says so.

**Language:** account → device cookie `md-locale` → `Accept-Language` → English. Saving the language also writes the device cookie, so that device's sign-in page follows it after signing out.

**Regional formats:** date (`31/12/2026`, `31-12-2026`, `31.12.2026`, `12/31/2026`, `2026-12-31`), 12/24-hour time, first day of the week (Monday, Saturday, Sunday), number separators (`1,234.5`, `1.234,5`, `1 234,5`) and units (metric, US customary). Automatic values are derived on the server with `Intl` from the browser's most preferred language tag (`Accept-Language`, e.g. `nl-BE`), or the interface language without one. They are computed per request and never stored, so server and browser render the same text. Formatting helpers in `src/preferences/regional.ts` only change how a value is shown.

**Timezone:** Automatic is the zone the browser reports, kept per device in the cookie `md-timezone` by `DeviceTimeZone` (root layout), checked on load and when the page becomes visible again (travel), followed by a refresh. A chosen zone is stored on the account and applies on every device. Before a device has reported its zone, UTC is used and the settings page says so. Zones are checked with `Intl`; the spelling is kept as given, because browsers and Node.js disagree on canonical names (`Europe/Kyiv`, `Europe/Kiev`). next-intl gets the effective zone too. `date-fns`/`date-fns-tz` are not needed yet.

**Display name:** optional, 1–50 characters (code points) after NFC normalization and trimming, without control characters or bidirectional overrides; never derived from the email address. On the dashboard it is wrapped in Unicode isolates (FSI…PDI), so a right-to-left name cannot reorder the sentence around it.

**Personal context with zero Homes:** the dashboard greets the person, shows today's date in their formats and timezone, an honest empty widget area (widgets are S17), and a Homes card beside it with **Create a Home** and **Join a Home**. These lead to pages that say plainly that Homes are not built yet (S09 and later). Nothing creates a Home; the card never blocks or interrupts. The top bar keeps the Personal context.

**Migrations on hosted projects:** the owner applies each new file in `supabase/migrations/` in the Supabase SQL Editor, oldest first, following `docs/supabase-migrations.md`, with a read-only check query that shows which files are applied: on `madeora-preview` when a PR with a migration is ready for testing, on `madeora-production` just before merging the release PR that contains it. Migrations stay additive (expand first), so code already deployed keeps working. No database credential goes into GitHub or Vercel.

## Consequences

- Every signed-in page reads one row (one query per request, shared by layout, page and next-intl). Signed-out pages with a stale session cookie may ask Supabase Auth to confirm it once more than before.
- A person can write their own row through the Data API without the route's checks. Only their own row is affected, the database refuses malformed values, and readers ignore what they do not recognise.
- Automatic regional formats are a best guess from `Accept-Language` (many browsers send `en-US` regardless of region); every setting can be overridden.
- The SQL Editor does not record applied migrations in Supabase CLI's history table. If the hosted projects ever move to `supabase db push`, mark the files already applied with `supabase migration repair --status applied <version>` first.
- A manual step per migration per project. When migrations become frequent, revisit an automated, secret-handling deployment (needs the owner's approval and a check of the €0 rule).
- Theme stays on the device (ADR 0006 left it open; not part of S07).
- The settings page language choice still applies at each arrow-key step (ADR 0006); with two languages that is acceptable.
