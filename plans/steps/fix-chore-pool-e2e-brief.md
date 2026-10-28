# fix/chore-pool-e2e brief

Failure: chore-pool.spec.ts:63 step "Ward claims; chore leaves Bea's pool" (line 99), fails in every CI run with real Realtime (2 PR runs + main 17955dc). Not caused by PR #37.
Cause: Realtime delivery of the pool signal event to the second open page is not confirmed working in CI (first run with real Realtime; earlier local tests only exercised the refresh path). Exact reason not proven: CI trace not downloadable from this container.
Fix: ChorePoolLive also reads the signal version every 5 s while the tab is visible (delivery not assumed, architecture Realtime C). Unit test added; existing timer tests adapted.
Checks: chore-pool.test.tsx 20+ pass, prettier, eslint, tsc clean. Full suite not run (no Supabase stack here); CI is the check.
Review: reviews/steps/fix-chore-pool-e2e-review.md = PASS (0 blocker/high); medium/low fixed (5 s interval, rename, comment) except root cause.
