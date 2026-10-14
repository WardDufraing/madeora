# S11 brief: member directory, display names, nicknames and personal accents

- **Branch:** `feat/member-directory-and-profiles` (from `main` at `2f487d4`)
- **Date:** 2026-10-14
- **Builds on:** S07 (preferences, ADR 0009), S09 (Homes, roles, engine, name policy, ADR 0011), S10 (invitations, ADR 0012)

## Scope

1. **Strict name rule for display names.** The global display name switches to the S09 visible-name policy (`apps/web/src/names/visible-name.ts`): no zero-width, direction or padding characters, emoji allowed. The same rule covers the two new Home-specific names below. One SQL function, `private.is_visible_name(text, int)`, becomes the database rule for Home names, display names and the new Home names, so the three checks cannot drift. The S09 accepted/refused list moves to a shared fixture that both the TypeScript test and a new database test run.
2. **Home presentation per member** (spec 444, 479, 519): in each Home, a person may set a **nickname** and a **Home display name**, each optional and reset on its own. Effective Home name = nickname, else Home display name, else global display name. Only the person sets their own; no Owner or Administrator can. Stored in `public.home_member_profiles`, one row per membership, deleted with the membership (leaving a Home clears the overrides).
3. **Personal accent colour** (spec 487, 495, 504): a global accent on the account (settings) and an optional per-Home override. A curated palette plus a custom colour. Everything drawn from it goes through `deriveAccent`, so contrast holds whatever is chosen. The global accent colours the app in the Personal context; inside a Home the person's effective accent for that Home applies. In the Home's member directory the accent also identifies the member, always next to their name.
4. **Member directory** `/homes/{homeId}/members` (spec 453): every current member in one list, with an initials avatar in their effective accent, effective Home name, role and a "you" marker. Default order Owner, Administrators, Members, then name; sort by name or role; filter by role; result count, reset and an empty no-match state. Duplicate names get a privacy-safe qualifier (the date they joined this Home). Managers see a link to invitations (pending invitations stay separate from members). No private account fields (email, account id, other Homes) reach other members: the directory comes from one `security definer` function that returns membership ids, never account ids.
5. **My profile in this Home** `/homes/{homeId}/profile`: nickname, Home display name and accent override, each showing whether it is inherited or overridden, with **Reset to global**, a live preview of how other members see you, and a non-blocking warning when the chosen accent is identical or hard to tell apart from another member's in this Home, with suggested alternatives.
6. **Avatars:** initials avatars only (from the effective name, coloured with the effective accent; a neutral symbol when there is no name). Image avatars need file storage, which the build plan brings with R2 in S15.

**Out of scope (later steps):** image avatars and upload (S15, R2); welcome personalization after joining and the effective-permissions overview (separate optional flows; a later step); the shared Home theme managed by the Owner (needs the appearance capability, S12); member management actions, role changes, removal (S12); children and guardian colour reset, Household Displays (their own steps); realtime directory updates (pages read fresh on each request); profile visibility controls for extended optional fields.

Spec: `docs/product/Project-specification.md` lines 444–451 (global name/avatar with per-Home overrides), 453–460 (member directory), 479–485 (nicknames, duplicates), 487–493 (personal accent with per-Home overrides), 495–502 (member-identifying colours), 504–509 (duplicate colours with warnings), 519–526 (global identity, Home presentation, privacy by default), 3239 (accent derivation), 2451 (curated palette plus custom picker). Architecture: §4, §5, §6, §8, §9, §13, §21. CLAUDE.md: authorization strategy C, forms strategy A, frontend strategy B.

## Decisions (defaults chosen; owner may correct)

1. **Name limits:** nickname and Home display name follow the global display name: 1–50 characters after NFC and trimming, the S09 visible-name rule. No word filter for "abusive" text (the spec names it but gives no list; inventing one is out of scope).
2. **Existing display names that break the new rule are cleared** (set to empty) by the migration, because a check constraint would otherwise block every later preference save for that account. Only names that contain invisible or direction characters are affected; production holds demo and early accounts. The person sees an empty name and can type it again.
3. **Effective name order:** nickname → Home display name → global display name → a translated "Member without a name" label. Other members see only the effective name, never which source it came from or the global name behind an override.
4. **Accent storage:** `#rrggbb` lower case, `user_preferences.accent_color` (global) and `home_member_profiles.accent_color` (Home). No choice = the spec's default purple. Nobody gets an automatically assigned colour: the spec makes the member colour the person's own accent, so assigning one would change their app's colour without asking.
5. **Curated palette (12 colours):** the spec purple `#8057f5` plus blue `#2563eb`, sky `#0284c7`, teal `#0d9488`, green `#16a34a`, ochre `#a16207`, amber `#d97706`, orange `#ea580c`, red `#dc2626`, pink `#db2777`, magenta `#c026d3`, slate `#475569`. In Settings, picking the purple means "the default", which uses each theme's own shade of it (`#8057f5` light, `#936bff` dark), as the spec's token table does. Custom: any solid `#rrggbb` via a colour input and a hex field. When `deriveAccent` has to adjust a colour for readable text, the preview says so.
6. **Similar-colour warning:** identical hex, or OKLab distance below 0.06 (just noticeable difference for small swatches), counts as "hard to tell apart". Compared only with other current members of the same Home; never with other Homes. Suggestions: the three palette colours furthest from every other member's colour.
7. **Directory view choices** (sort, role filter) live in the URL (`?sort=`, `?role=`), so they are server-rendered, shareable, reversible with Back and never change anyone else's view. No stored per-person directory preference yet.
8. **No member detail page.** Selecting yourself opens My profile; other members have no actions until S12, so their row is not a link.
9. **Accent on the page:** the app layout renders a small `<style>` with the derived light and dark accent variables for the global accent; the Home layout renders a second one for the Home's effective accent, which wins inside that Home. Values come only from validated hex colours. Household Displays (later) will not use it.
10. **API:** `PATCH /api/v1/me/preferences` gains `accentColor`; new `PATCH /api/v1/homes/{homeId}/profile` (nickname, displayName, accentColor; each `null` resets) with the shared same-origin, JSON and size checks, the engine action `home.profile.editOwn`, and the person's own session so RLS applies. The directory is read on the server through `supabase.rpc('home_directory')`. A Home you are not a member of answers 404, as in S09.
11. **Audit:** personal presentation changes are not written to the Home audit log (they are not Home changes, and the log must never hold names). Membership ids keep attribution stable.

## Done when

- A person sets a nickname, Home display name and accent in one Home; another member of that Home sees the effective name and colour in the directory; a member of a different Home sees nothing of it; resetting one override keeps the other; changing the global name or accent changes only Homes that still inherit it (E2E plus database tests).
- Nobody can write or read another person's `home_member_profiles` row through the Data API, an Owner cannot change another member's profile, a former member's row is gone and the directory refuses non-members (SQL RLS tests, route tests).
- Display names, nicknames and Home display names refuse every case on the shared refused list, in the app and in the database (unit tests and database test over one fixture).
- The directory sorts, filters, shows counts, empty and duplicate-name states, works with keyboard and screen reader (component tests with axe, E2E).
- Format, lint, typecheck, unit tests, build, database tests and E2E pass; the independent review returns PASS or all BLOCKER/HIGH findings are fixed; review saved in `reviews/steps/S11-review.md`.

## Tests

- **Unit:** visible-name shared fixture; display-name, nickname, Home-name and accent schemas; effective name and accent resolution; colour distance and suggestions; accent CSS rendering; engine matrix with the new actions; route handlers (CSRF, content type, size, unauthenticated, non-member 404, invalid input, success, database failure).
- **Component:** accent picker, Home profile form (inherit/override/reset, preview, warning), directory (sort, filter, reset, count, empty, duplicate names, you marker), axe.
- **Database:** `tests/db/rls/home_member_profiles.test.sql` (own row only, current members only, cross-Home, forged ids, Owner cannot edit others, departure clears, directory function refuses non-members and never returns account ids); `tests/db/rls/visible-names.test.ts` over the shared fixture; constraint and grant checks.
- **E2E:** two people in one Home set overrides and see each other; a third person in another Home sees nothing; reset; global change propagates only to inheriting Homes; axe on the directory and My profile.

## Risks

- `home_directory` is `security definer`: it must re-check current membership itself and return only the listed columns. Covered by RLS tests with a non-member, a former member and forged Home ids.
- Clearing invalid display names changes stored data (decision 2). The migration only touches rows the new rule refuses.
- The migration must be applied to `madeora-preview` and `madeora-production` by the owner before those environments use this release (`docs/supabase-migrations.md`).

## Model

This step adds RLS policies, a `security definer` function that exposes co-member data and cross-Home privacy rules, so it needs the heavier model. This session already runs on it.
