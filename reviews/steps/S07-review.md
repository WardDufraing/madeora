# S07 review: personal context and preferences

- **Branch:** `feat/personal-preferences`
- **Reviewer:** independent review subagent acting as a senior developer/architect, with fresh context and no prior knowledge of the project. Its only inputs were the branch diff against `main` (lockfile excluded, unchanged), `plans/steps/S07-brief.md`, and verbatim excerpts of the spec references (`docs/product/Project-specification.md` lines 93–98, 425–431, 444–450 and 611–638; `Project-entry.md` lines 66 and 82).
- **Rounds:** 3. Each round was a new reviewer on the then-current full diff.
- **Final verdict:** **PASS** (round 3). There were no BLOCKER or HIGH findings in any round.
- This is an AI review. It is not a GitHub human code-review approval.

## Round 1: PASS

| ID  | Severity | Finding                                                                                                                                    | Outcome                                                                                                                                                                   |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | MEDIUM   | The regional form sent all five settings, so a page left open on one device reset formats chosen on another.                               | **Fixed.** Only the settings changed in the form are sent. Switching to Automatic is the one explicit full reset. Tests added for a stale page and for an unchanged save. |
| M2  | MEDIUM   | ICU-formatted examples were rendered in a client component, which risks a hydration mismatch between Node and browser ICU.                 | **Fixed.** Every example is made on the server (`regionalSamples`) and passed as props.                                                                                   |
| M3  | MEDIUM   | App and database disagreed on forbidden name characters (`\p{Cc}` vs `[[:cntrl:]]`, for example U+2028), so some names came back as a 500. | **Fixed.** Both now refuse the same explicit code points. A check violation (23514) maps to 400. Parity cases were added to the Vitest and SQL tests.                     |
| M4  | MEDIUM   | The owner guide could leave the preview database on an outdated migration.                                                                 | **Fixed.** Apply to preview only once the migration is final. A recovery procedure (undo, then re-apply) is documented for preview only.                                  |
| L1  | LOW      | Invisible bidirectional characters were written literally in source.                                                                       | **Fixed.** All are now `\uXXXX` escapes. A scan of every changed file finds none left.                                                                                    |
| L2  | LOW      | The body was read fully before the size check, and a `NaN` Content-Length was accepted.                                                    | **Fixed.** Streamed 4 KB cap; a malformed Content-Length gets a 400. Tests added.                                                                                         |
| L3  | LOW      | A "signed out" save error refreshes to the sign-in page, losing the typed value.                                                           | Accepted. Signing in again is required either way, and the alert explains it.                                                                                             |
| L4  | LOW      | One SQL assertion proved nothing; tests for timestamp inserts and truncate were missing.                                                   | **Fixed.**                                                                                                                                                                |
| L5  | LOW      | The regional preview was not announced.                                                                                                    | **Fixed.** `aria-live="polite"`.                                                                                                                                          |
| L6  | LOW      | Custom with every format left on Automatic reloads as Automatic.                                                                           | Accepted. Since round 2 the form no longer claims to have saved anything in this case.                                                                                    |
| L7  | LOW      | The UTC fallback was not disclosed on the dashboard; the Dutch weekday is lowercase.                                                       | Fallback **fixed** in round 2. Lowercase accepted: it follows Dutch convention.                                                                                           |
| L8  | LOW      | `DeviceTimeZone` refreshed on every load when cookies are blocked.                                                                         | **Fixed.** It refreshes only when the cookie was stored. Test added.                                                                                                      |

## Round 2: PASS

| ID  | Severity | Finding                                                                                    | Outcome                                                                                                                                                              |
| --- | -------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | MEDIUM   | A name made only of invisible characters was accepted.                                     | **Fixed in the app.** A name needs at least one visible letter, digit, symbol or punctuation mark; Hangul fillers don't count. See round 3 M1 for the database side. |
| M2  | MEDIUM   | A chosen zone that the browser's ICU does not know crashes the settings preview.           | **Fixed.** The preview falls back to the zone name. Test added.                                                                                                      |
| L1  | LOW      | The timezone and name forms sent unchanged values, undoing changes made on another device. | **Fixed.** Nothing is sent when the form is unchanged. Tests added.                                                                                                  |
| L2  | LOW      | Custom with every format on Automatic claimed "saved".                                     | **Fixed.**                                                                                                                                                           |
| L3  | LOW      | The dashboard showed UTC without saying so.                                                | **Fixed.** "(in UTC, until this device reports its timezone)".                                                                                                       |
| L4  | LOW      | `btrim` and JS `trim` differ.                                                              | See round 3 M1.                                                                                                                                                      |
| L5  | LOW      | A literal no-break space was in source.                                                    | **Fixed.**                                                                                                                                                           |
| L6  | LOW      | Possible extra Auth calls per request.                                                     | Verified as acceptable. `getVerifiedIdentity` is request-cached and makes no network call without a session cookie.                                                  |
| L7  | LOW      | The end-to-end test did not cover units.                                                   | **Fixed.** Units are now checked after a reload and on a second device.                                                                                              |

## Round 3 (final diff): PASS

| ID  | Severity | Finding                                                                                                                                                                                                    | Outcome                                                                                                                                                                                                                                                                                   |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | MEDIUM   | Zero-width and format characters inside a name (for example `Sam​`) are still accepted. The database lacks the visible-character and Unicode-trim rules, so direct Data API writes are laxer than the app. | **Accepted for S07; owner decision.** Today only the person sees their own name, and the app re-validates whatever it reads. A full default-ignorable policy, with a matching database rule, belongs in S09/S11, when names first become visible to other Home members. Owner to confirm. |
| M2  | MEDIUM   | The timezone end-to-end test could race the device-zone refresh, and its date-only checks were weak.                                                                                                       | **Fixed.** The dashboard exposes the zone it rendered in (`data-time-zone`), and the test waits for it with a retrying assertion.                                                                                                                                                         |
| L1  | LOW      | Unit tests depended on the runner's own timezone.                                                                                                                                                          | **Fixed.** Vitest pins `TZ=UTC`.                                                                                                                                                                                                                                                          |
| L2  | LOW      | On a first visit the timezone list preselected UTC instead of the device's zone.                                                                                                                           | **Fixed.** The detected zone is preselected while the form is untouched. Test added.                                                                                                                                                                                                      |
| L3  | LOW      | A literal zero-width joiner was in a test.                                                                                                                                                                 | **Fixed.**                                                                                                                                                                                                                                                                                |
| L4  | LOW      | RLS was enabled after the grants; the owner check did not cover the grants.                                                                                                                                | **Fixed.** RLS is enabled right after `create table`. The check query also confirms no delete and no `updated_at` writes.                                                                                                                                                                 |
| L5  | LOW      | `useWatch(...) as FormValues` casts.                                                                                                                                                                       | Accepted. The forms always register every field with defaults, so the watched object is complete.                                                                                                                                                                                         |

Round 3 also listed these remaining risks. All are accepted for now:

- The preferences API has no rate limit; a person can only spam their own row.
- `md-locale` and `md-timezone` are per device, so the next person on a shared device sees the previous language on the sign-in page.
- Bare `en` in `Accept-Language` gives US conventions; each setting can be overridden.
- A language cannot be returned to "not chosen".
- Travel is only detected when the page becomes visible again.
- The spec's starter widgets and layout editing arrive in S17.

## Found by test runs after round 3

- The first-visit refresh from `DeviceTimeZone` could cancel an animation that an existing design-system test was waiting on, giving an intermittent `AbortError`. Fixed in two ways:
  - The shared test session is saved only after the device has reported its zone.
  - `settle()` treats cancelled animations as finished.
- One end-to-end run hit an `ECONNRESET` in an S06 sign-out test. It did not reproduce: the auth spec passed 2×, and the full suite passed 3 more times.

## Not re-reviewed

The fixes for round 3 and the test-stability changes above were not shown to a fourth reviewer. They are test changes, a reordering of migration statements, a preselect in the timezone form, and an escaped character. All checks were run again afterwards.

## Final checks

All run locally against the real Supabase CLI stack in Docker, not the fallback.

| Check                                                                                | Command                                    | Result                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Formatting                                                                           | `pnpm format:check`                        | Pass                                                                            |
| Lint                                                                                 | `pnpm lint`                                | Pass                                                                            |
| Typecheck                                                                            | `pnpm typecheck`                           | Pass                                                                            |
| Unit and component tests                                                             | `pnpm test`                                | Pass. Web: 394 tests                                                            |
| Production build                                                                     | `pnpm build`                               | Pass                                                                            |
| Client/server boundary                                                               | `pnpm test:boundary`                       | Pass                                                                            |
| Database and RLS tests                                                               | `pnpm db:reset --yes`, then `pnpm test:db` | 17/17 pass                                                                      |
| RLS mutants (widened select, insert or update policy; delete grant; timestamp grant) | ad hoc                                     | All 5 caught                                                                    |
| Database types                                                                       | `pnpm db:types --check`                    | Up to date                                                                      |
| End-to-end tests                                                                     | `pnpm test:e2e` (full suite)               | 90/90, two consecutive runs                                                     |
| End-to-end repeat of `preferences.spec.ts`                                           | `--repeat-each=3`                          | 28/28                                                                           |
| Spec guard                                                                           | `pnpm check:spec --base origin/main`       | Pass                                                                            |
| Dependency audit                                                                     | `pnpm audit:deps`                          | Pass                                                                            |
| Secret scan                                                                          | gitleaks 8.30.1                            | History clean. Working tree: only ignored build output and an existing S06 test |
