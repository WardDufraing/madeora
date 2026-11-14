# fix: E2E smoke timeouts — brief

**Branch:** `fix/e2e-timeouts` from `main`.
**Why:** CI "E2E smoke tests" is red on `main` (#82–#85) and on PR #86. Run 43535722638, second attempt: 209 tests, 205 passed, 4 failed, all 30 000 ms test timeouts under runner load (`members.spec.ts:50`, `privacy-lifecycle.spec.ts:236`, `roles-and-ownership.spec.ts:64` and `:163`). The first attempt hung until the 30-minute job limit. The suite alone takes about 25 minutes. No failure relates to Ora (all 5 Ora specs pass).
**Change:** `test.slow()` (3x limit) on exactly those four tests (long multi-person flows; per the independent review, a global limit raise would also triple every test that is already slow; retries stay 0 so flakes stay visible); job `timeout-minutes` 30 → 45 in `.github/workflows/ci.yml`. No test is skipped, removed or weakened.
**Not done:** speeding up the suite (sharding or fewer sign-ins); suggested follow-up if it keeps growing.
**Check:** only CI can show it (full E2E is not run locally by project rule).

**Review:** `reviews/steps/fix-e2e-timeouts-review.md` (PASS; its MEDIUM-1 adopted). Open: why the first attempt hung to the job limit is unexplained; if the total nears 40 minutes, shard the job.
