# Independent review: fix/e2e-timeouts

Verdict: PASS (0 BLOCKER, 0 HIGH, 2 MEDIUM, 2 LOW)

Scope reviewed: staged diff (ci.yml job timeout 30 -> 45 min; playwright.config.ts per-test timeout 30 s -> 60 s; brief), the four named specs, and the rest of the workflow.

## Assessment

- Proportionate: yes. The failing tests are multi-person journeys that register several users, seed Homes, sign in more than once, run axe checks and open extra browser contexts inside a single test body (members.spec.ts:50, privacy-lifecycle.spec.ts:236, roles-and-ownership.spec.ts:64 and :163). Setup helpers count toward the test timeout. 30 s is plausibly too little for these under a loaded runner; 60 s is a modest doubling.
- Does not weaken CI: no test skipped, removed or loosened; retries stay 0; `forbidOnly` kept; assertion/expect timeouts untouched. Only the ceiling moves.
- 45 min job limit: sound. The suite takes ~25 min, so 30 min left only ~17% headroom; 45 gives 80%. Other jobs' limits (5/5/10/15/30/20) are unchanged and unaffected.

## Findings

### MEDIUM-1: interaction with existing `test.slow()` multiplies the new limit

Many specs already call `test.slow()` (e.g. specs/meal-planner.spec.ts:57, recipes.spec.ts:68, points-rewards.spec.ts:48). Slow triples the configured timeout, so these tests go from 90 s to 180 s without anyone deciding that. Impact: a genuinely stuck slow test now burns 3 min of the 45; several such hangs could again exhaust the job, and the longer ceiling can hide a regression that makes a test 2x slower. Remediation: acceptable to merge as is; optionally, instead of (or in addition to) the global bump, mark only the four named tests `test.slow()`, matching repo convention and keeping the 30 s default (90 s for them) for everyone else.

### MEDIUM-2: the first attempt "hung to the job limit" is not explained

Brief says attempt 1 ran to 30 min. If that was a hang (not just slowness), a larger job limit and larger test limit only delay detection, and the root cause (runner load, worker count, Supabase stack contention) is untreated. Impact: possible recurrence of a 45 min cancelled job. Remediation: after merge, check the timing of the first CI run on the new config (Playwright list reporter shows per-test durations); if total approaches 40 min, do the follow-up (shard the e2e job with `--shard` in a matrix, or set `workers` explicitly). Consider recording this follow-up as a plan item rather than leaving it only in the brief.

### LOW-1: no overall `globalTimeout` and no step-level timeout

tests/e2e/playwright.config.ts:26. A single hung run is bounded only by the job limit. Optional: set `globalTimeout` (e.g. 40 min) so Playwright stops cleanly and still produces the HTML report, which is uploaded `if: failure()`. When the job is cancelled by the runner at the limit, the report step may not run, losing the diagnostics for exactly the case being debugged.

### LOW-2: comment accuracy

playwright.config.ts:22-25 and ci.yml comment are fine, but the config comment lists three spec names while the brief lists four failing tests; harmless. The `:163` test is nested in a describe with `allowedConsoleErrors`; unaffected.

## Checks

- Requirements/CLAUDE.md "never weaken CI / never skip tests": satisfied.
- Security, tenant isolation, secrets, migrations, accessibility: not touched.
- Performance/cost: GitHub Actions minutes on a public/free plan; worst case +15 min on failed runs. No spend concern noted; confirm repository is within free minutes (not verifiable here).
- Verification: only CI can show it; not run locally (consistent with project rule).

## Remaining risks

- Suite growth: 25 min and rising; 45 min is a stopgap. Sharding is the durable fix.
- Flakiness is still visible (retries 0) but slow-but-passing regressions are now masked up to 60 s (180 s for slow tests).
- Unmeasured: whether 60 s is actually enough; the brief has no per-test duration evidence for the four tests. Check durations in the first green run.
