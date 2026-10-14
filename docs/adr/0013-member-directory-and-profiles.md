# ADR 0013: Member directory, Home-specific names and personal accents

- **Status:** Accepted for S11 within the approved architecture (§4, §5, §6, §8, §9, §13) and CLAUDE.md (authorization strategy C, forms strategy A, frontend strategy B). Defaults chosen without asking, listed below, are open to correction by the owner.
- **Date:** 2026-10-14
- **Step:** S11, member directory and profiles (brief: `plans/steps/S11-brief.md`)

## Context

From S11 members of a Home see each other. The spec gives each adult one global display name and accent, optional per-Home overrides (a nickname, a Home display name, a Home accent), a simple permission-filtered member directory, and privacy by default: no account email, account id or other Home reaches another member ("Confirmed global adult avatar and display name with per-Home overrides", "Confirmed simple Home member directory", "Confirmed optional per-Home nicknames", "Confirmed personal accent color with per-Home overrides", "Confirmed optional duplicate member accent colors", "Confirmed global identity with Home-specific profile presentation"). S07's review deferred the strict name rule for display names to this step.

## Decision

**One name rule.** `private.is_visible_name(text, int)` is the database's visible-name rule (S09's Home-name policy, unchanged). Home names, global display names, nicknames and Home display names all check it; the app's rule stays `src/names/visible-name.ts`. One shared list of accepted and refused names (`src/names/visible-name-cases.ts`) runs against both, in the unit tests and in `tests/db/rls/visible-names.test.ts`. The function is executable by `authenticated` (check constraints run as the writer) and allowlisted in the baseline test. Stored display names the new rule refuses are cleared by the migration, because the check would otherwise block every later preference save of that account.

**Home presentation.** `public.home_member_profiles` (Home, account, nickname, display name, accent; `null` = inherit) belongs to the membership through a composite foreign key with `on delete cascade`, so a departure deletes it and a re-join starts from the global defaults. RLS: only your own row, only while you are a current member; no delete (reset writes `null`); a trigger stops a row moving to another Home or person. Nobody, whatever their role, writes another adult's row; there is no engine action for it either (`home.profile.editOwn` is about the actor's own row only).

**Directory.** `public.home_directory(home)` is `security definer` (empty `search_path`, execute for `authenticated` only). It refuses anyone who is not a current member of that Home with the same error whether or not the Home exists, and returns per member only the membership id (the stable Home-member identifier), role, joining date, whether it is the caller, the effective name (nickname, else Home display name, else global display name) and the effective colour (Home accent, else global accent). It never returns account ids, emails, the source of a name or the global value behind an override. Membership RLS is unchanged: people still read only their own membership rows directly.

**Accent.** One solid `#rrggbb` per account (`user_preferences.accent_color`) and per Home override. Every shade comes from `deriveAccent`, so contrast holds for any colour. The app layout renders the global accent as a small style sheet that overrides the accent tokens (`renderAccentCss`, which only accepts a validated colour); a Home's layout renders the Home override after it. The curated palette lives in `@madeora/design-tokens` and is published as `--md-color-palette-*`. A non-blocking warning appears when a colour is identical or close (OKLab distance under 0.06) to another member's in the same Home, with palette suggestions far from everyone; colours of other Homes are never compared.

**Avatars** are initials on the member's colour until file storage arrives (R2, S15).

**API and pages.** `PATCH /api/v1/me/preferences` gains `accentColor`; `PATCH /api/v1/homes/{homeId}/profile` changes only the caller's own row (user id from the verified session; 404 for a Home they do not belong to). Pages `/homes/{homeId}/members` (sort and role filter as GET parameters; duplicate names get the joining date as a qualifier) and `/homes/{homeId}/profile`.

## Defaults chosen (owner may correct)

Nickname and Home display name 1–50 characters with the visible-name rule, no word filter; the effective-name order above; "Member without a name" for people without any name; the twelve-colour palette (purple, blue, sky, teal, green, ochre, amber, orange, red, pink, magenta, slate), where purple in Settings means the theme-dependent default; no automatically assigned member colours (everyone without a choice has the default purple); the 0.06 similarity threshold; directory view choices in the URL only; no member detail page until S12; personal presentation changes are not written to the Home audit log; welcome personalization after joining, the effective-permissions overview and the shared Home theme are later steps.

## Consequences

- The migration must be applied to `madeora-preview` and `madeora-production` by the owner (`docs/supabase-migrations.md`, with a check for S11).
- Every signed-in page reads the account's preferences (already cached per request) to colour the page; Home pages read one more row.
- Rollback: drop `home_directory`, `home_member_profiles` and `user_preferences.accent_color` (`docs/supabase-migrations.md`, "If you need to undo S11"). The stricter name checks can stay; names the migration cleared are not restored.
