# Independent review: UX dashboard greeting (feat/ui-dashboard-greeting)

Verdict: PASS (no BLOCKER or HIGH findings; two MEDIUM items recommended before merge)

Scope reviewed: `greeting.ts`, its use in `apps/web/src/app/(app)/page.tsx`, en/nl strings, unit and e2e test changes. Read-only review; no source edited. Tests were not re-run by the reviewer.

## Findings

### MEDIUM-1: display name is not bidi-isolated in the h1

`apps/web/src/app/(app)/page.tsx` lines 69-79 pass `{ name }` raw into `greeting*Named`. The Welcome widget (`widget-content.tsx` line 132) deliberately wraps the same name in `isolate()` (FSI/PDI) so an RTL name cannot reorder the surrounding words. The new h1 loses that protection.
Remediation: `{ name: isolate(name) }` (from `@/invitations/format`). Check that the `name` regex in tests still matches (the prefix regexes do).

### MEDIUM-2: two greetings and two dates on one screen

The personal dashboard now shows the h1 "Good morning, Name" with a date subtitle, and the default Welcome widget (`widget-content.tsx` 123-150) still shows "Welcome, Name" plus the date. This is redundant for the starter layout and e2e `dashboard.spec.ts` line 82 still asserts "Welcome to Madeora". Not a defect, but a product/UX decision.
Remediation: confirm with the owner that the duplication is accepted, or follow up by changing the starter layout or the widget copy.

### LOW-1: no page-level test for the named variants or the time-zone path

`page.test.tsx` only checks the unnamed greeting through a regex that accepts any period and either locale, so it cannot catch a wrong period, a wrong zone, or the named strings. Remediation: use `vi.setSystemTime` with a mocked effective zone (for example 23:30Z with Asia/Tokyo gives morning, evening in New York) and assert the exact en text, plus one named case and one nl case. Also assert `generateMetadata` still yields "Dashboard".

### LOW-2: `greeting.test.ts` has no DST case and no non-"00" midnight hour proof

Boundaries at 12:00/18:00 and 00:05 are covered. Add a DST-day case (for example Europe/Amsterdam on 2026-03-29 and 2026-10-25, where local noon is 10:00Z/11:00Z) and local midnight (23:00Z gives 00 in Amsterdam, morning). Verified manually in Node: `hourCycle: "h23"` returns "00" at local midnight, never "24".

### LOW-3: no defence for the "24" legacy-engine edge

Older engines combining `hour12: false` with `hour: "2-digit"` could return "24" (which would read as evening). With `hourCycle: "h23"` modern Chrome, Firefox, Safari and Node return "00". Optional hardening: `Number(...) % 24`. A time zone string that `Intl` rejects would throw RangeError; `getEffectiveTimeZone` goes through `resolveTimeZone`, which validates, so this is acceptable.

### LOW-4: formatter constructed per request

Negligible cost; no action.

### LOW-5: copy

Period boundaries (12:00, 18:00; no "night" greeting for 00:00-04:59) are a product choice; "Good morning" at 02:00 is acceptable but undocumented. nl copy ("Goedemorgen/middag/avond") is correct, ICU placeholder `{name}` is present in all six keys, and the old `greeting`/`greetingNamed` keys are still used by the widget.

## Explicit checks

- Time zone: uses `getEffectiveTimeZone()` (account zone, else device cookie, else UTC), the same zone as the subtitle date. Correct, and DST is handled by `Intl`. PASS.
- Hydration/caching: the h1 is rendered in a server component from cookies and session (dynamic, per request); no client clock, so no hydration mismatch; no `revalidate` or `dynamic = "force-static"` on the page or layout. PASS.
- Privacy: only `stored.displayName` of the signed-in person (via `requireIdentity` and `getStoredPreferences`) is used; no Home or child data. PASS.
- Heading semantics: `PageHeader` renders the only h1; `generateMetadata` still uses `Nav.dashboard` (tab title "Dashboard · Madeora"; `shell.spec.ts` 309 and `smoke.spec.ts` 7 still expect that and remain valid). PASS.
- Stale tests: grepped `tests/e2e` and `apps/web/src` for the old h1 "Dashboard". Remaining hits are the sidebar/mobile-nav/display links, the page title, and "Dashboard templates" (a different page). The five e2e specs and three page.test cases were updated. No stale expectations found. The remaining `Dashboard` string in `dashboard.spec.ts` 313 is unrelated.
- Home dashboard (`homes/[homeId]/page.tsx`) is unchanged and out of scope.
- Security, secrets, migrations: none touched.
- Accessibility: the h1 text is longer but plain; no new contrast or motion concerns.

## Remaining risks and test gaps

- Bidi isolation (MEDIUM-1) is unresolved.
- Exact greeting text per period/zone and named/nl variants are only covered by the pure function test, not at page level.
- e2e regexes pass at any hour, so they do not verify period correctness.
- The review did not execute the test suite or the build.
