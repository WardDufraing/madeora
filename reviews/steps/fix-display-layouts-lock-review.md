# Review: fix/display-layouts-lock-e2e

**Verdict: PASS**

Scope: one spec, `tests/e2e/specs/display-layouts-lock.spec.ts` (immediate `sql` count replaced by `expect.poll(...).toBe("2")`). No product code touched.

## Root cause
Correct and consistent with the code.
- `relock()` (display-screen.tsx) clears `unlockLeft` synchronously, so the "Unlocked for Ward" indicator disappears before any network call. It then calls `endUnlockHere()` (retried once), then `refresh()`.
- The spec's last wait (`display-unlocked` count 0) therefore proves nothing about the server. The audit count ran at once and could see only `display.unlock_opened`. That is a plain race in the test.
- No product bug found on the write path. `display_end_unlock` deletes the session and audits `display.unlock_ended` when `expires_at > now()`. The session is 5 minutes, so it is live here. The only paths that remove the row first are privacy lock, revoke and an expired session, and none of them occurs before this point. Ambient mode fires after the Home's idle timing (default 300 s), and it only calls the same end endpoint.
- If the end call failed, the one retry would run. If the event were never written (a real bug), the poll would time out. The fix does not hide that case; it fails with a clear count mismatch.

## Fix
- Same assertion, same value, same query. It now waits for the eventual state, so it is not weakened. Count is exact ("2"), not ">=2".
- The default `expect` timeout is 15 s (playwright.config.ts), which is ample for one POST plus one RPC. The synchronous `spawnSync` psql inside the poll callback is fine; the default 100/250/500/1000 ms intervals apply.
- The comment explains why polling is needed.

## Findings
- BLOCKER / HIGH: none.
- MEDIUM: none.
- LOW 1: Not verifiable locally. The spec needs the Supabase stack, so the claim "it passes" rests on CI. Require the CI run on the PR to be green; ideally re-run the e2e job a couple of times to confirm no residual flake.
- LOW 2: The poll covers the audit row. The following steps (privacy lock asking for the PIN again) depend on the session being deleted, and the same poll now orders that, since the end RPC both deletes the session and audits in one transaction. No new race. Other unlock/lock assertions elsewhere were not exhaustively checked; none are in this diff.
- LOW 3: The Playwright failure message from `poll` prints only expected/received; acceptable. Optional: a `message:` option naming the unlock audit events.
- LOW 4 (process): the brief's "Review:" line points at this file; the brief says root cause was inferred from code and CI output, not reproduced. That is reasonable, but note it in the PR description.

## Checks
Requirements: met (no behaviour change). Cross-Home isolation/permissions/secrets/validation/migrations: not affected. Test coverage: strengthened ordering, not reduced. Accessibility/performance: n/a. Maintainability: minimal, idiomatic.

Remaining risks: if CI still fails after 15 s polling, treat it as a real product bug in the `/display` unlock-end endpoint path (not investigated here because the SQL and client look correct).
