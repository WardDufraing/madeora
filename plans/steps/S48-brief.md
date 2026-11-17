# S48 · Acceptance suite — feature brief

**Branch:** `test/acceptance-suite` from `main` (S47d merged, PR #90).
**Model:** Sonnet (test code plus two small fixes).
**Order reading:** S47's done-condition ("Ora change" journey without free text) is met by S47a to S47d. The rest of S47's deferred list (meal to shopping, recurring and series changes, multi-record updates, deletion, reminders content, milestone celebrations) is optional and stays Ward's call; it does not block S48.
**Sources:** build plan S48; `docs/product/Project-entry.md` "First implementation journeys".
**Done when:** the ten journeys each have a Playwright test, every main screen passes axe in both themes, and denied and offline states are checked.

## Scope

1. **Journey map** (`docs/acceptance-matrix.md`): each of the ten journeys → the spec(s) that walk it. Nine already had a long end-to-end spec from their own step; the map makes that explicit.
2. **Gap closed: "Ora change"** (`specs/acceptance-ora-change.spec.ts`): no browser test walked the guided change. Now: open Ora, preview that saves nothing, edit, action-named confirm, result with Undo, Undo to Trash; complete a task from Ora and Undo it.
3. **axe on every main screen** (`specs/acceptance-screens.spec.ts`, list in `support/screens.ts`): every personal and Home screen that needs no record id, light and dark theme.
4. **Denied and offline states** (`specs/acceptance-states.spec.ts`): a person outside a Home reaches none of its screens and never sees its name; a plain Member sees manager-only screens as not allowed; a change made offline is never shown as saved, keeps what was typed and is sent once the connection returns.

## Findings the suite made (fixed in this PR)

1. **Real S47 bug:** Ora sits beside the app shell, but the toast provider lived inside the shell, so opening any guided change (Add a task, Complete a task, ...) threw "useToast must be used inside a ToastProvider" and the form never appeared. Unit tests wrapped the component in a provider, so they could not see it. Fix: the provider moved to `components/shell/app-toasts.tsx`, above both.
2. **Dark-theme contrast:** the "Open Shopping" link in the meals transfer notice failed axe in dark theme (link colour on the info notice). It now uses the normal text colour, underlined.

## Behaviour noted, not changed (Ward may want a follow-up)

Task and other forms built on TanStack mutations hold a request made offline until the connection returns, with the form busy and no message. Nothing is shown as saved and text is kept ("never pretend offline actions succeeded" holds), but nothing says "waiting for connection". Adding that note is a product decision, not part of S48.

## Defaults picked (Ward may change)

1. Test code only, except the two small fixes the suite itself forced (see Findings).
2. Screens with a record id keep their own module's axe checks; sign-in, child sign-in, display and child space are checked in their own specs.
3. Offline checks cover Tasks (the pattern every create form follows) and Ora; the other modules share the same form and query code.

## Status

- [x] Scoping and brief
- [x] New specs green locally (fallback stack: Ora change, screens light and dark, states); full suite runs on CI
- [ ] Independent review (`reviews/steps/S48-review.md`)
- [ ] PR
