# Trigger.dev setup (owner)

What the owner does once to run Madeora's background jobs in a hosted environment (S13, [ADR 0017](adr/0017-background-jobs.md)). Nothing here is needed for local development or CI. Job conventions and the runbook: [`background-jobs.md`](background-jobs.md).

**€0 rule:** Trigger.dev's Free plan costs nothing and stops tasks when its monthly $5 of usage is spent. If any screen asks for a payment card, a billing address or a paid plan, **stop and tell Claude**; do not enter one ([cost register](provider-cost-register.md)).

## 1. Account and project

1. Open <https://cloud.trigger.dev> and choose **Continue with GitHub** (the Free plan needs a verified GitHub account).
2. Create an organization (for example `Madeora`). If you are asked to pick a plan, choose **Free**.
3. Create a project named `madeora`.
4. Open the project's **Project settings** and copy the **Project ref** (`proj_…`). It is not a secret.

**Check:** the organization's billing or usage page says **Free** and shows the $5 monthly allowance; no card is on file.

## 2. A Supabase secret key for the jobs

Do this for each Supabase project that will run jobs (`madeora-production` now; `madeora-preview` only if the Free plan includes a staging environment, see step 3).

1. In <https://supabase.com/dashboard>, open the project → **Project Settings** → **API Keys**.
2. Under **Secret keys**, create a new secret key named `trigger-dev`, and copy it (`sb_secret_…`). Use it only in Trigger.dev, never in Vercel or `.env.example`.
3. Apply the S13 migration `supabase/migrations/20261021090000_background_jobs.sql` to that project as in [`supabase-migrations.md`](supabase-migrations.md).

**Check:** in the SQL Editor, `select * from public.job_outbox_stats();` returns one row of zeros.

## 3. Environment variables in Trigger.dev

1. In the Trigger.dev project, open **Environment Variables**.
2. For **Production**, add:
   - `APP_ENV` = `production`
   - `SUPABASE_URL` = the `madeora-production` API URL (`https://<project-ref>.supabase.co`, from Supabase → Project Settings → Data API)
   - `SUPABASE_SERVICE_ROLE_KEY` = the `trigger-dev` secret key from step 2
   - For email (S14), also `EMAIL_TRANSPORT` = `resend`, `EMAIL_FROM` = `Madeora <no-reply@mail.madeora.studio>`, `RESEND_API_KEY` = the `madeora-production-app` key and `APP_URL` = the production address (`https://…`, no path). Creating the Resend key is `docs/email-setup.md`, step 5. Without them the jobs still run and record emails as "not configured"; in-app notifications are unaffected.
3. If the environment list also shows **Staging** on the Free plan, you may set it up the same way with `APP_ENV` = `preview` and the `madeora-preview` project. If it is not there, previews run no jobs; nothing in the app needs them yet.
4. Do not add a Trigger.dev key or the Supabase secret key to Vercel. The web app needs no Trigger.dev key yet: emails go out on the 5-minute schedule. (Vercel only gets the flag `EMAIL_TRANSPORT`, `docs/email-setup.md` step 6.)

**Check:** the variables are listed under Production with their values hidden.

## 4. Deploy the tasks (when a feature needs jobs, or now to try them)

From a clone of the repository on your computer, with `main` checked out and `pnpm install` done:

1. `cd packages/jobs`
2. `pnpm dlx trigger.dev@4.6.4 login` and approve the login in the browser.
3. `pnpm dlx trigger.dev@4.6.4 deploy --env prod`. The project ref is the default in `packages/jobs/trigger.config.ts` because the remote build does not see your shell environment; to use another Trigger.dev project, change that default in a PR.

Without a browser, `TRIGGER_ACCESS_TOKEN=tr_pat_…` (a personal access token from Trigger.dev → Account → Personal Access Tokens) replaces step 2. Never commit the token or paste it into chat; revoke it afterwards.

**Check:** Trigger.dev → **Tasks** lists `sample-ping` and `outbox-dispatch`, and **Schedules** shows `outbox-dispatch` every 5 minutes.

## 5. Smoke test

1. In the Supabase SQL Editor of the same project, run:

   ```sql
   select private.enqueue_job('sample-ping', 1, 'smoke-' || to_char(now(), 'YYYYMMDDHH24MISS'), '{"label": "smoke-test"}');
   ```

2. Wait up to 5 minutes.
3. In Trigger.dev → **Runs**, an `outbox-dispatch` run succeeded and a `sample-ping` run succeeded; its log shows `jobs.sample_ping.ran`.
4. In the SQL Editor: `select status, attempts, last_error_code from private.job_outbox order by created_at desc limit 1;` shows `dispatched`, `1` and an empty error code.

## 6. Email smoke test (S14)

Needs step 3's email variables and a redeploy of the tasks (step 4).

1. In the app, sign in, open a Home you own, **Invite people**, choose **Email invitation** and invite a mailbox you can read.
2. Wait up to 5 minutes. In Trigger.dev → **Runs**, an `invitation-email` run succeeded; its log shows `jobs.invitation_email.sent` and no address.
3. The invitation shows **Sent**, and the email arrives from `no-reply@mail.madeora.studio`.
4. Try the in-app side: open `/settings/notifications`, turn **By email** on under **Your defaults**, and ask a second account to request to join your Home with an invitation link. You get a notification in the bell at once and an email within about 5 minutes. A `notification-email` run is listed in Trigger.dev.

Check in the SQL Editor: `select kind, email_status from public.notifications order by created_at desc limit 5;` shows `sent` for the emailed one.

## 6. Alerts

If the Free plan offers alerts (project → **Alerts**), add an email alert for failed runs in Production. If it does not, look at the `outbox-dispatch` runs and `public.job_outbox_stats()` weekly until notifications exist (architecture §22).

## Removing it again

Delete the Trigger.dev project, then the `trigger-dev` secret key in Supabase. Jobs then wait in the outbox, and nothing is lost.
