# S49 · Release readiness — brief

**Branch:** `docs/release-readiness` from `main` (S48 merged, PR #91).
**Model:** Sonnet is enough for this step (documents and plans, no security or RLS code).
**Sources:** build plan S49; ADR 0002, 0005, 0008; `docs/production-setup.md`; `docs/provider-cost-register.md`; `architecture.md` §25, §41, §42.
**Done when:** Ward has decided budget, commercial status, backups and GDPR position; `docs/release-readiness.md` holds the release-PR checklist, staging plan, monitoring and alerting plan, backup and restore drill, and incident notes; and the items marked "needs decision" are filled in.

## State found

- Production already deploys from `production` (ADR 0008), demo data only. Supabase Free (2 project slots both used: preview, production), Vercel Hobby, Resend/Trigger.dev/R2 free tiers, domain madeora.studio paid by Ward.
- No staging, no health endpoint, no public privacy notice page, no uptime alerting, no backup (Supabase Free has none you can rely on; CLAUDE.md forbids claiming otherwise).
- Release process exists (`docs/github-setup.md` D, `Release source` check).

## Decisions only Ward can take (recommended defaults first)

1. **Is Madeora commercial?** Vercel Hobby is non-commercial only. Default: yes if real households use it or any charging is planned, then Vercel Pro is needed before real users.
2. **Hosting budget.** Default: approve a small monthly budget when real household data starts: Vercel Pro, Supabase Pro (daily backups, no pause), keep staging as a local/CI stack. Exact prices to be re-verified on the vendor pages before purchase.
3. **Backups.** Default: Supabase Pro daily backups plus a monthly manual `pg_dump` restore drill into a scratch project; R2 versioning/replication decided with the first real photo upload. No PITR yet.
4. **GDPR position.** Default: EU-only hosting (Supabase Frankfurt, R2 EU jurisdiction, Resend EU region if available), vendor DPAs accepted, public privacy notice naming processors (Supabase, Vercel, Resend, Cloudflare incl. Turnstile, Trigger.dev, Google), retention periods as proposed in `docs/release-readiness.md`.
5. **Staging.** Default: no dedicated hosted staging until budget exists; use the preview deployment plus a pre-release rehearsal on a local stack with migrations applied.

## Done without a decision

`docs/release-readiness.md`: release-PR checklist, monitoring/alerting plan, backup and restore drill outline, incident notes. Docs only; no code, no spec changes.

## Not done yet (after decisions)

Privacy notice page, `/api/health` endpoint, retention jobs, staging environment, provider-cost-register rows. Each would be its own small step.

## Progress

- [x] State check, brief written
- [x] `docs/release-readiness.md` drafted
- [ ] Ward's decisions
- [ ] Independent review (one round)
- [ ] PR opened, CI green
