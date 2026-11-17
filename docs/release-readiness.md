# Release readiness

S49. Nothing here changes the product specification.

## 0. Decisions (Ward, 2026-11-17)

1. **Plan:** stay on Vercel Hobby for now. Hobby is non-commercial only, so the first beta phase must stay non-commercial (no charging, no ads). Re-decide before any commercial use.
2. **Budget:** none yet. The first beta phase runs on free plans only (€0 rule stays).
3. **Backups:** not yet. Free Supabase has no usable backup, so production keeps demo or beta-tester data only, with the written warning that data may be lost. Section 4 is the plan for later.
4. **GDPR:** EU hosting only (section 5).
5. **Staging:** none. Vercel preview plus local rehearsal (section 2). This deviates from `CLAUDE.md` (staging required at the release stage); the deviation needs an ADR and a separate owner-approved `CLAUDE.md` PR.

## Real-data gate

Production stays demo-only (the owner's and demo accounts) until all of these are done and recorded in an ADR:

1. The privacy notice and terms are live (new small step).
2. A data-loss warning is shown at sign-up (text to draft in that step).
3. Ward has recorded in the ADR that he accepts "no recovery" for the beta, or backups exist. `CLAUDE.md` otherwise blocks production without a recovery strategy.
4. Hobby fair use is settled: the beta stays a small known group (family and friends), the current Vercel fair-use policy is re-read before sign-up opens and the date recorded. If Vercel objects, move to Pro or another host, which needs a budget decision.
5. The EU checklist in section 5 is complete.

Outside testers join only after this gate.

## 1. Release PR checklist (`main` → `production`)

Before opening the PR:

1. `main` CI is green on the commit to release.
2. New SQL files are applied to `madeora-production` first (`docs/production-migrations.md`); migrations are forward-only and backward-compatible with the running app (expand, migrate, contract).
3. While no backup exists (decision 3), production holds demo data only, so a destructive migration is accepted as data loss. Once backups exist (section 4), verify a backup from today first.
4. New environment variables are set in Vercel Production, never in Git.
5. Trigger.dev jobs are redeployed from the same commit when jobs changed.
6. Provider cost register and quotas re-checked when a new service or feature uses one.

PR: title `release: <date>`, body lists the commits, migrations, new variables, risks, and the rollback plan. Wait for `Release source` and all other checks, read the diff, then Ward merges.

After merge: Vercel deployment Ready and Current; run the smoke checks in `docs/production-setup.md` section 13 that touch what changed; check the Trigger.dev run list and Supabase logs for errors for 30 minutes.

Rollback: Vercel Instant Rollback returns to the previous production deployment only, and works only if the expand/contract rule held (the old app must run on the migrated schema); a migration is never rolled back, fix forward with a new migration.

## 2. Staging (decided: none)

Both free Supabase slots are used and there is no budget. Rehearse each release: on a local Supabase stack run `supabase db reset` (migrations and seed), apply the new migration, run the RLS tests and the smoke list from `docs/production-setup.md` section 13, and check the Vercel preview. A local stack has no production-shaped data, real Auth or SMTP, so that part is only checked after release. Revisit when a budget exists.

## 3. Monitoring and alerting plan

Uses native tools only (architecture §41; no Sentry).

| What                               | Where                                                                                                                   | Alert                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| App errors                         | Vercel runtime logs (Hobby keeps them only briefly, verify the current window)                                          | Alert-driven checks right after a release or a report; no weekly look |
| Uptime of `www.madeora.studio`     | Free external uptime check (to verify, needs a free tier without card) or a `/api/health` endpoint **(new small step)** | Email to Ward                                                         |
| Database health, auth errors, size | Supabase dashboard, Reports and Logs                                                                                    | Supabase email for usage warnings                                     |
| Failed jobs, stuck outbox          | Trigger.dev run list, `docs/background-jobs.md`                                                                         | Trigger.dev failure email                                             |
| Email delivery                     | Resend dashboard, bounce and complaint rates                                                                            | Resend email                                                          |
| Free-tier limits                   | Provider cost register review each release                                                                              | Recurring GitHub issue, owner Ward                                    |

Alert mechanisms above are unverified on free plans: in a one-time setup, enable each in its provider and confirm a test alert arrives, then record the date here. Supabase Free pauses after a week idle, which takes production down: the uptime check should call a health endpoint that touches the database (also keeps the project active; check the uptime tool's terms), and "project paused" is a known incident cause. Logs must stay privacy-safe: no tokens, signed URLs, email bodies or child data.

## 4. Backup and restore drill (decided: not yet; plan for later)

Facts: Supabase Free has no usable backup and pauses after a week idle; Supabase Pro has daily backups for a limited number of days and PITR is an extra paid add-on (verify on the vendor page). Migrations rebuild structure, never user content. R2 objects are not covered by database backups.

Proposed routine once real data exists:

1. Daily Supabase backup (paid plan) plus a monthly manual logical dump (`pg_dump` of `public` and `auth`) stored in a private place outside the repository.
2. Monthly restore drill (needs the budget, or use a local Supabase/Postgres stack because no free project slot is left; restoring `auth` needs a written procedure first): restore the latest backup, run the production smoke checks against it, note the time taken and any gap, delete the scratch project.
3. R2: decide versioning or a second bucket with the first real photo upload (file-storage strategy B); drill = restore one deleted test object.
4. Dumps contain personal data, child data and password hashes: encrypt at rest, limit access, delete after a stated period (propose 90 days), and count them in the deletion promise. R2 drills need versioning, which is undecided.
5. Targets to agree: data loss of 24 h holds only with the paid daily backup (a monthly dump alone means up to a month); restore time proposed one working day.

## 5. GDPR position (EU hosting only decided; the rest proposed)

EU hosting only is decided. The rest is proposed and should be checked by a lawyer before real users. "EU only" cannot be literal for Turnstile and the Vercel edge: it means data at rest and processing in the EU where the provider offers it, with remaining third-country transfers (SCCs or the EU-US Data Privacy Framework) named in the privacy notice.

EU checklist (complete before the real-data gate):

- [ ] Vercel function region set to an EU region (for example `fra1`); `apps/web/vercel.json` sets none, so the default is a US region today.
- [ ] R2 bucket created with the EU jurisdiction (fixed at creation, separate endpoint); if the production bucket is not EU, recreate it before real data.
- [x] Resend is Ireland (`docs/email-setup.md`); Supabase is Frankfurt.
- [ ] Trigger.dev region options verified.
- [ ] Each vendor's DPA accepted, date recorded; Art. 30 record of processing and a DPIA note because children's data is processed.

- Accept each vendor's DPA; list them as processors: Supabase, Vercel, Resend, Cloudflare (R2, Turnstile), Trigger.dev, Google (sign-in, calendar).
- Public privacy notice and terms page before real sign-ups (new small step).
- Rights already built: personal and Home exports (`privacy-export-build`), account and Home deletion with 30-day recovery.
- Retention proposals (spec leaves them open): application logs only as long as Vercel keeps them (no 30-day promise on Hobby), audit records 12 months, Ora history 7 days (built), export archives 7 days (built).
- Children: parental-consent age by country is already modelled; the privacy notice must explain child data.

## 6. Incident notes

1. **Detect:** alert or user report. **Contain:** if data exposure is possible, switch production sign-in off (Supabase Auth settings) or roll back in Vercel.
2. **Assess:** which Homes and data; use Vercel, Supabase and Trigger.dev logs.
3. **Secrets:** rotate affected keys in their provider, update only that environment, redeploy (`docs/production-setup.md`, Ongoing operation).
4. **Notify:** Ward is the controller. Within 72 hours of becoming aware of a personal-data breach he must notify the data-protection authority of his country, unless the breach is unlikely to put people at risk; affected users must be told when risk is high. Children's and guardian data raise the risk assessment. Keep an internal breach register for every breach, reported or not. Processors (Supabase, Vercel, others) must tell Ward without undue delay.
5. **Recover:** fix forward through a normal PR; restore from backup only for data loss.
6. **Review:** write a short post-incident note in `docs/` within a week.

## 7. Follow-up steps once decided

Privacy notice and terms pages; health endpoint; retention jobs; staging environment; cost-register rows for any paid plan.
