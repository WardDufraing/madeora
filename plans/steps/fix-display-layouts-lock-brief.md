# fix: display-layouts-lock e2e fails on main — brief

**Branch:** `fix/display-layouts-lock-e2e`. **Model:** Sonnet (single-spec test race, no security logic).
**Failure (main run 45580880741):** `display-layouts-lock.spec.ts:111` expected 2 audit events (`display.unlock_opened`, `display.unlock_ended`), received 1. Fails since the UX8a merge (#115 CI passed once, later main runs failed; redesign PRs inherit it).
**Root cause:** the test, not UX8a. `display-screen.tsx` `relock()` hides the "Unlocked for…" indicator at once and ends the session on the server asynchronously (`endDisplayUnlock`, one retry). The test waited only for the indicator to vanish, then counted audit rows immediately, so `display.unlock_ended` was not yet written. UX8a behaviour (optimistic hide, server-audited end) matches its brief and review; the SQL (`display_end_unlock`) audits correctly when the session is unexpired.
**Fix:** the count is now `expect.poll(...)` until 2 (default timeout). Same expectation, no weakening, no product change.
**Local checks:** format, lint, typecheck (logs in scratchpad). The spec itself needs the Supabase stack (CI only).
**Review:** `reviews/steps/fix-display-layouts-lock-review.md`.
