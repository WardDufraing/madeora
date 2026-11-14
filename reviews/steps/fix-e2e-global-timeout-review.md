# Review: fix/e2e-global-timeout

**Verdict: PASS** (0 BLOCKER, 0 HIGH, 2 MEDIUM, 2 LOW)

Scope: `tests/e2e/playwright.config.ts` (`timeout: 60_000`), `.github/workflows/ci.yml:125` (45 to 60 min), brief. No test skipped, removed or weakened; retries stay 0; assertion waits unchanged; spec files untouched; product spec untouched.

## Judgement

Proportionate as a stop-gap. Seven different tests failed on a 5 s assertion wait inside a 30 s budget, and a different set fails each run. That pattern is runner-load jitter, so per-test `test.slow()` cannot converge. Doubling the budget is consistent with it. This does not weaken CI: failures still fail (retries 0), assertion and `expect.poll` timeouts are unchanged, and a wrong value still fails fast. It only widens the "test hung" budget.

## Findings

- **MEDIUM-1** `tests/e2e/playwright.config.ts:27`, `.github/workflows/ci.yml:125`. Cost of hung tests and job limit. A genuinely hung test now burns 60 s instead of 30 s. With 0 retries and about 209 tests on 2 workers, a systemic hang (stack down, sign-in broken) could take about 100 min worst case, so the 60 min job limit becomes the real stop and the run ends cancelled, not failed with a useful list. Remediation: acceptable now; keep the job limit as the backstop, and add `globalTimeout` (for example 55 min) in the Playwright config so a systemic hang ends with a report and traces rather than a cancelled job. Longer term, shard (below).
- **MEDIUM-2** `.github/workflows/ci.yml:124-125` (comment) and brief. The root cause is unproven (the brief says so). Suite time is already 25-32 min on 2 workers, so a 60 min limit hides growth: the brief set 45 min as the "shard" trigger previously and this removes that early warning. Remediation: record in the brief a concrete trigger (for example suite over 40 min, or any timeout at 60 s) to shard the E2E job with `--shard=i/n` in a matrix, merging reports; and capture per-test durations (`--reporter=json` or the list reporter timings) from the next run to find the slow tests (probably repeated sign-ins and multi-person set-up).
- **LOW-1** `tests/e2e/playwright.config.ts:27` interaction with `test.slow()`. 21 spec files call `test.slow()` (about 30 uses), which now means 3 x 60 = 180 s instead of 90 s, and `invitations.spec.ts:22` sets 90 s explicitly (now lower than a slow test, harmless). Those already-slow tests are the ones that most need the room, so this is mostly benign, but their hang cost doubles. Remediation: after the next green run, review whether some `test.slow()` markers are now redundant and could be removed to restore tight limits.
- **LOW-2** `tests/e2e/playwright.config.ts:22-26` comment cites run IDs and per-run failure lists; such comments go stale. Remediation: shorten to the rationale (shared runner, 2 workers beside the production build and Supabase stack) and keep run IDs in the brief only.

## Checks

Requirements and CLAUDE.md rules (never weaken CI, never skip tests): met. Security, tenant isolation, secrets: not affected. Test coverage: unchanged. Maintainability: one-line config change. Google job (`ci.yml:181`, 30 min) is unchanged; it uses the same config only when `PLAYWRIGHT_FAKE_GOOGLE=1`, so its tests also get 60 s, which is harmless.

## Remaining risks / what could still fail

- If slowness is real (for example an app request stalling on the local stack, a cold Next.js route on first hit, or sign-in rate limiting), 60 s will not help and failures just move; traces are kept on failure (`retain-on-failure`), so inspect them first.
- Shared state or ordering between parallel workers under load (fullyParallel with 2 workers) could still cause non-timeout flakes.
- Total suite time will not drop; it can grow slightly if tests that would have failed now wait longer.

## Better or complementary alternatives

1. Shard the E2E job (2 to 3 shards in a matrix; each with its own Supabase stack) - cuts wall time and per-runner contention; costs more Actions minutes (check the free-plan quota, EUR 0 rule).
2. Reduce load per test: reuse signed-in storage state instead of repeated UI sign-ins, create fixtures via the DB helper instead of UI flows.
3. Workers: more than 2 would worsen contention on a 2-vCPU runner; fewer (1) would be slower overall. Keep 2.
4. Add `globalTimeout` as in MEDIUM-1.
