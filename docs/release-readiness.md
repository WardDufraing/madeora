# Release readiness

Draft for S49. Items marked **(needs decision)** wait for Ward. Nothing here changes the product specification.

## 1. Release PR checklist (`main` → `production`)

Before opening the PR:

1. `main` CI is green on the commit to release.
2. New SQL files are applied to `madeora-production` first (`docs/production-migrations.md`); migrations are forward-only and backward-compatible with the running app (expand, migrate, contract).
3. A backup exists from today (section 4) before any migration that changes or drops data.
4. New environment variables are set in Vercel Production, never in Git.
5. Trigger.dev jobs are redeployed from the same commit when jobs changed.
6. Provider cost register and quotas re-checked when a new service or feature uses one.

PR: title `release: <date>`, body lists the commits, migrations, new variables, risks, and the rollback plan. Wait for `Release source` and all other checks, read the diff, then Ward merges.

After merge: Vercel deployment Ready and Current; run the smoke checks in `docs/production-setup.md` section 13 that touch what changed; check the Trigger.dev run list and Supabase logs for errors for 30 minutes.

Rollback: Vercel Instant Rollback for the app; a migration is never rolled back, fix forward with a new migration.

## 2. Staging (needs decision)

Both free Supabase slots are used. Options: (a) default, no hosted staging: Vercel preview plus local rehearsal with migrations and seed; (b) a paid Supabase project for staging. Revisit when real users exist.

## 3. Monitoring and alerting plan

Uses native tools only (architecture §41; no Sentry).

| What                               | Where                                                                                                                   | Alert                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| App errors and slow requests       | Vercel logs and Observability                                                                                           | Vercel email on failed deployment; weekly log look |
| Uptime of `www.madeora.studio`     | Free external uptime check (to verify, needs a free tier without card) or a `/api/health` endpoint **(new small step)** | Email to Ward                                      |
| Database health, auth errors, size | Supabase dashboard, Reports and Logs                                                                                    | Supabase email for usage warnings                  |
| Failed jobs, stuck outbox          | Trigger.dev run list, `docs/background-jobs.md`                                                                         | Trigger.dev failure email                          |
| Email delivery                     | Resend dashboard, bounce and complaint rates                                                                            | Resend email                                       |
| Free-tier limits                   | Provider cost register review each release                                                                              | Monthly reminder                                   |

Logs must stay privacy-safe: no tokens, signed URLs, email bodies or child data.

## 4. Backup and restore drill (needs decision)

Facts: Supabase Free has no usable backup and pauses after a week idle; Supabase Pro has daily backups for a limited number of days and PITR is an extra paid add-on (verify on the vendor page). Migrations rebuild structure, never user content. R2 objects are not covered by database backups.

Proposed routine once real data exists:

1. Daily Supabase backup (paid plan) plus a monthly manual logical dump (`pg_dump` of `public` and `auth`) stored in a private place outside the repository.
2. Monthly restore drill: restore the latest backup into a scratch Supabase project, run the production smoke checks against it, note the time taken and any gap, delete the scratch project.
3. R2: decide versioning or a second bucket with the first real photo upload (file-storage strategy B); drill = restore one deleted test object.
4. Targets to agree: maximum acceptable data loss (proposed 24 h) and restore time (proposed one working day).

## 5. GDPR position (needs decision)

Proposed, to be confirmed by Ward and, before real users, checked by a lawyer:

- EU hosting: Supabase Frankfurt (done), R2 with EU jurisdiction, Vercel functions in an EU region, Resend EU region.
- Accept each vendor's DPA; list them as processors: Supabase, Vercel, Resend, Cloudflare (R2, Turnstile), Trigger.dev, Google (sign-in, calendar).
- Public privacy notice and terms page before real sign-ups (new small step).
- Rights already built: export (S45-era privacy exports), account and Home deletion with 30-day recovery.
- Retention proposals (spec leaves them open): application logs 30 days, audit records 12 months, Ora history 7 days (built), export archives 7 days (built).
- Children: parental-consent age by country is already modelled; the privacy notice must explain child data.

## 6. Incident notes

1. **Detect:** alert or user report. **Contain:** if data exposure is possible, switch production sign-in off (Supabase Auth settings) or roll back in Vercel.
2. **Assess:** which Homes and data; use Vercel, Supabase and Trigger.dev logs.
3. **Secrets:** rotate affected keys in their provider, update only that environment, redeploy (`docs/production-setup.md`, Ongoing operation).
4. **Notify:** a personal-data breach must be reported to the data-protection authority within 72 hours and to affected users when risk is high. Ward is the contact until a processor/controller arrangement is decided.
5. **Recover:** fix forward through a normal PR; restore from backup only for data loss.
6. **Review:** write a short post-incident note in `docs/` within a week.

## 7. Follow-up steps once decided

Privacy notice and terms pages; health endpoint; retention jobs; staging environment; cost-register rows for any paid plan.
