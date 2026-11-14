# fix: E2E global test timeout — brief

**Branch:** `fix/e2e-global-timeout` from `main` (after PR #87).
**Why:** #87 gave four named specs `test.slow()`, and that run passed (24.5 min). The next run (PR #86 merged with main, run 43626184696) took 31.7 min on 2 workers and 7 different tests failed, all "Test timeout of 30000ms exceeded" while waiting on a 5 s assertion: goals.spec.ts:105, habits.spec.ts:57, numeric-habits.spec.ts:41 and :110, privacy-lifecycle.spec.ts:114, storage.spec.ts:64, tasks.spec.ts:266. None touches Ora (all Ora specs passed). A different set fails in each run, so marking tests one by one does not converge.
**Change:** `timeout: 60_000` in `tests/e2e/playwright.config.ts` (assertion waits unchanged, retries stay 0 so flakes stay visible); E2E job `timeout-minutes` 45 → 60. No test skipped, removed or weakened.
**Not proven:** that the cause is only runner load (the logs show timeouts, not wrong values). If a run still fails with 60 s, the next step is real investigation or sharding the job, not more time.
**Check:** only CI shows it.

**Review:** `reviews/steps/fix-e2e-global-timeout-review.md` (PASS, 2 medium, 2 low). Adopted: shorter config comment; a concrete trigger below. Not adopted: `globalTimeout`.
**Shard trigger:** if the suite exceeds 40 minutes, or any test times out at 60 s, shard the E2E job (`--shard=i/n` matrix, merged reports) instead of raising limits again. Many specs already use `test.slow()` (now 180 s); revisit them after the next green run.
