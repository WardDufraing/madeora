# S48 independent review (Acceptance suite)

Verdict: CHANGES_REQUIRED (0 BLOCKER, 2 HIGH, 5 MEDIUM, 4 LOW). Reviewed from the diff and a read of the named specs and routes; the e2e suite was not run.

## Checks
- Requirements (ten journeys each have a test): partly. Nine are mapped to older specs (not re-verified end to end), one new spec. The matrix has one wrong path (LOW-1).
- axe on every main screen, both themes: weaker than claimed (HIGH-1, MEDIUM-1, MEDIUM-2).
- Denied and offline: thin (HIGH-2, MEDIUM-3, MEDIUM-4).
- Cross-Home isolation: outsider test is reasonable but see MEDIUM-3.
- Secrets/migrations/security of product fixes: no concerns. The AppToasts move is correct (client provider above the shell and Ora, server layout composes it fine).
- Accessibility of fixes: link colour change fixes the one known contrast failure; see LOW-3.

## HIGH

### HIGH-1 Screen list is hand-maintained and incomplete; no guard against drift
`tests/e2e/support/screens.ts` omits routes that exist and need no id:
- personal: `/meals/copy`, `/meals/print`, `/copy-to-home`
- Home: `/meals/copy`, `/meals/print`, `/children/new`, `/children/link`, `/close`, `/leave`, `/recovery`
- plus the `/[section]` catch-all.
Stated done condition is "every main screen". The matrix and brief claim "every personal and Home screen that needs no record id", which is false. The next step that adds a page silently escapes axe.
Remediation: add the missing routes, or a Vitest/Node test that globs `apps/web/src/app/(app)/**/page.tsx`, drops dynamic segments, and fails unless each path is in the list or in an explicit, justified exclusion list.

### HIGH-2 Offline coverage is one Tasks flow, and it asserts an accepted UX defect
`acceptance-states.spec.ts:66-100`. The done condition is "offline states are checked". The suite covers a single create form, and its header comment ("on every module") overstates it. The matrix cites Ora's offline panel, but that is a Vitest/jsdom test (`ora-assistant.test.tsx`), not a Playwright check. The test pins "button disabled, no message, request held" which the brief itself calls a gap (no "waiting for connection" note). It locks in the behaviour a later fix must change. The "sent exactly once" claim uses `toHaveCount(1)`, which passes the moment the first row appears and cannot see a later duplicate from a retry.
Remediation: (a) add at least one Playwright offline check on a different pattern (Ora panel offline, or a read screen showing its offline/stale state) or state honestly in the matrix that Ora is unit-only; (b) assert the invariant, not the incidental disabled state (no "saved" toast or success text while offline), and drop or soften `toBeDisabled`; (c) after reconnect, wait for the row then `expect.poll`/short settle and re-count, or reload and count server-side.

## MEDIUM

### MEDIUM-1 Axe pass can be a false pass: redirects, loading and error states
`acceptance-screens.spec.ts:374-391`. Only HTTP status >=400 is a problem. A route that redirects to the dashboard, renders a generic "not found/not allowed" panel, or is still showing a skeleton passes (h1 visible plus axe clean). No `page.url()` check against the requested path, no wait for network idle/hydration, and the account has no data, so only empty states are measured (lists with rows, populated widgets, dialogs are never axe-checked). The dead branch at 381-387 (error if no h1 and no main, then expect h1 anyway) is redundant.
Remediation: assert `new URL(page.url()).pathname === path` (list intended redirects explicitly), wait for a page-specific testid or `networkidle`, and seed a little data for the heaviest screens (tasks, shopping, meals) or say empty-state-only in the matrix.

### MEDIUM-2 Dark theme is never confirmed applied
`colorScheme: "dark"` relies on the app following `prefers-color-scheme`. If a stored preference or default wins, the "dark" run silently re-tests light. No assertion on the resolved theme (data attribute or a computed background).
Remediation: assert the root theme attribute/computed `color-scheme` per run. Also run the Ora dialog axe check (acceptance-ora-change) in dark, or note it is light only.

### MEDIUM-3 Denied-state assertions are mostly negative
`acceptance-states.spec.ts:421-465`.
- Outsider: reached = URL contains homeId, leak = name in `body.innerText`; there is no positive check of the neutral notice and no wait for streamed content after `goto`, so the leak check could run before late RSC chunks (Suspense). `<title>` and non-body places are not checked.
- Plain Member on `/invitations`: only "heading visible and no /invite/i button". A blank or broken page with an h1 passes; no positive "not allowed" text as on `/displays`. `getByRole("heading", {level:1})` without `.first()` risks a strict-mode failure if two h1 exist.
- `allowedConsoleErrors` (403/404, Failed to fetch) applies to the whole file, hiding unexpected 403/404 in the offline test.
Remediation: assert the positive refusal copy on both, add a wait on a stable element, and scope the console allowance per test with `test.describe` blocks.

### MEDIUM-4 Matrix claims not backed by what the named specs show
- `google/google-sign-in.spec.ts` does not exist under `tests/e2e/specs/`; the file is `tests/e2e/google/google-sign-in.spec.ts`.
- "each module spec's 'member without rights' case": only `tasks.spec.ts` contains that case by name; I could not confirm it for the rest. Claim should be limited to verified specs.
- "Google Calendar" journey is the S34 spec with Google replaced by seeded rows, and `google-sign-in` is sign-in, not Calendar. Honest labelling needed.
- "Shared screen ... prevent private leakage" is covered in `display-layouts-lock.spec.ts` (private note absent); fine, but the matrix should name which spec holds which half of each journey.
- "axe on auth, child and display screens" is listed as covered by `auth.spec.ts`, `child-sign-in.spec.ts`, `display-pairing.spec.ts`, not verified here.
Remediation: correct the path, restrict claims to what was walked, and add a one-line "known simulated" note for Google.

### MEDIUM-5 Single 30-minute test over about 90 pages x 2
`acceptance-screens.spec.ts:366`. One failing page wastes the run, a timeout loses all diagnostics, no per-route step reporting, and it is slow and serial on CI (about 180 navigations plus axe injection each). Aggregated `problems` is nice, but a hang at page N reports nothing.
Remediation: use `test.step` per path (or a parametrised test with a `beforeAll` shared account in a worker-scoped fixture), keep soft assertions, and drop the 30 minute timeout to something sized per step.

## LOW
- LOW-1 `docs/acceptance-matrix.md:158` wrong path (see MEDIUM-4).
- LOW-2 `acceptance-ora-change.spec.ts:238-248` `openAction` uses an instantaneous `isVisible()` right after the dialog opens; if suggestions render late it takes the Browse branch unnecessarily, or the final `button.click()` targets a stale locator. Wait for either the button or the browse control (`button.or(browse)`). `getByLabel("Task")` is a substring match and may collide with other labels; use `exact: true`.
- LOW-3 `meal-shopping-transfer.tsx:257` only this one `text-accent-fg` link on an info notice was fixed because it was the only one the empty-data walk hit. Grep for other `accent-fg` links inside `FormAlert`/tinted surfaces; they will fail dark axe once data exists.
- LOW-4 Ora spec checks "nothing saved before confirm" through a second tab opened before any submit; fine, but it never asserts the success toast (the very regression fixed by AppToasts). Add an assertion that a toast region exists in an Ora flow, or a layout-level test, so the provider cannot move back unnoticed. Brief status says "green locally (fallback stack)" with no CI evidence yet; that is acceptable only until CI runs.

## Remaining risks
- The nine pre-existing journey specs were not re-walked; the matrix is an assertion, not new proof.
- Fallback stack (no Realtime) differs from CI; green locally does not prove CI.
- Axe on empty-data screens misses contrast and structure problems in populated states.
- Offline UX gap (no "waiting for connection" message) remains an open product decision; the test should not freeze it.
