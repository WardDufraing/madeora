# Production environment setup

This guide takes the Madeora repository from an unconfigured production project to a working production deployment. Follow it once for initial setup, then use the release and operations sections for ongoing work.

Production deploys from the `production` branch only. Pull requests and `main` deploy previews. Follow [GitHub setup](github-setup.md) and [Vercel setup](vercel-setup.md) before configuring production.

## Production scope and prerequisites

- Production address: **https://www.madeora.studio** (the apex `madeora.studio` redirects to `www`).
- Production web deploy: Vercel project `madeora`, Production branch `production`.
- Production database: a separate Supabase project named `madeora-production` in EU (Frankfurt).
- Production uses separate credentials from previews. Never copy production secrets into GitHub, the repository, local development, Preview, or chat.
- Use synthetic/demo accounts and data until the release-readiness/privacy decision permits real household data.
- Keep new user sign-up closed until production email delivery works and the product/privacy decision has been approved. The owner can then enable it using [email setup, step 8](email-setup.md#8-open-production-sign-up).
- The GitHub repository and Vercel Hobby plan have non-commercial limits; review [provider costs](provider-cost-register.md) before production is used commercially.
- Make sure the free Supabase project capacity is available. Supabase Free permits two active projects per organization; pause an unused project if needed. Do not upgrade or add billing without the owner's decision.

Keep these values handy during setup: production URL, Supabase project URL and publishable key, Turnstile site key, R2 credentials, production Resend keys, and Trigger.dev project ref. Store secrets directly in their provider's secret settings.

## 1. Repository and release branch

1. Complete [GitHub repository setup](github-setup.md), including the `production` branch, merge settings, required checks where available, and the `Release source` workflow.
2. Complete [Vercel preview setup](vercel-setup.md), especially setting `production` as Vercel's Production Branch and enabling Standard Protection for previews.
3. Confirm the latest `main` checks pass and that the release source check accepts only a pull request from `main` into `production`.

Check: Vercel treats `production` as its Production environment; preview deployments remain protected by Vercel Authentication.

## 2. Production domain on Vercel

1. In Vercel open project `madeora` → **Settings** → **Domains**.
2. Add `www.madeora.studio`, assign it to **Production**, and follow the DNS records Vercel displays at the registrar.
3. Add `madeora.studio` and configure it to redirect to `www.madeora.studio`.
4. Wait for Vercel to report valid DNS and TLS.

Check: `https://madeora.studio` redirects to `https://www.madeora.studio`, which opens over HTTPS. Use this canonical URL for all callbacks, email links and Turnstile.

## 3. Create and configure Supabase Production

Create a separate project; do not point production at `madeora-preview`.

1. In Supabase create project `madeora-production` in the **Madeora** organization, region **Central EU (Frankfurt)** (`eu-central-1`). Generate a strong database password and keep it in Supabase's password manager/settings; it is not needed in Vercel.
2. Keep the project on the Free plan unless the owner separately approves a paid plan. Supabase Free may pause an inactive project; see Operations below.
3. Under **Authentication → Sign In / Providers** configure Email with email confirmations enabled, minimum password length `12`, default password requirements, and phone sign-in disabled. Keep **Allow new users to sign up** off until step 10.
4. Under **Authentication → URL Configuration**, set Site URL to `https://www.madeora.studio` and add the exact redirect `https://www.madeora.studio/**`. Remove unrelated redirect entries from this production project.
5. Configure the production confirmation and recovery email templates using `supabase/templates/confirmation.html` and `supabase/templates/recovery.html` (see [email setup](email-setup.md)).
6. Copy the project's **Publishable key** (starts `sb_publishable_`) and project URL from **Project Settings → API Keys / Data API**. The URL must end at `.supabase.co`; do not include `/rest/v1`.
7. Do not put a Supabase secret key, legacy `service_role` key or database password in a `NEXT_PUBLIC_` variable.

Check: project name and region are correct; email confirmation is on; production redirects contain the canonical URL; the publishable key is the only Supabase key intended for browser use.

## 4. Cloudflare Turnstile

1. Create a Cloudflare account if needed. No website transfer is required.
2. Create a Turnstile widget named `madeora-production`, hostname `www.madeora.studio`, mode **Managed**, pre-clearance **No**.
3. Save the **Site Key** for Vercel. Paste the **Secret Key** directly into Supabase **Authentication → Attack Protection → CAPTCHA**, select Cloudflare Turnstile and enable CAPTCHA protection.

Check: Supabase has CAPTCHA protection enabled and Turnstile selected. The secret key remains only in Supabase; the site key is public and goes to Vercel.

## 5. Email delivery

Follow [email setup](email-setup.md) for the full Resend domain-verification and SMTP instructions. Production requires all of the following:

1. Verify `mail.madeora.studio` in Resend and add its DNS records without replacing the website's root or `www` records.
2. Use a separate production Resend sending key for Supabase SMTP and another production app sending key for Trigger.dev.
3. Configure Supabase Production SMTP with `smtp.resend.com`, port `465`, username `resend`, sender `no-reply@mail.madeora.studio`, sender name `Madeora`, and the production Supabase SMTP key as password.
4. Set the app email variables in Trigger.dev (step 8). In Vercel set only `EMAIL_TRANSPORT=resend`; do not put `RESEND_API_KEY` or `EMAIL_FROM` in Vercel.
5. Keep sign-up closed until a confirmation email has been tested end to end.

## 6. Google sign-in (when enabled for the release)

Follow [Google sign-in setup](google-sign-in-setup.md). Create/configure the OAuth client and add the production callback URL in Google and Supabase. Use the production OAuth client credentials only in the Supabase Production Google provider settings. Do not add Google client secrets to Vercel. Apply the sign-in-method database migration before enabling Google.

Check: Google sign-in is enabled in Supabase Production and the production OAuth redirect is listed exactly. If the release does not enable Google sign-in yet, leave the provider disabled.

## 7. File storage (Cloudflare R2)

Follow [file storage setup](file-storage.md) to create the R2 bucket and a bucket-scoped access key. The production web app and background jobs must use the same production bucket configuration; use different credentials/buckets for other environments.

Configure these values directly in Vercel Production and Trigger.dev Production:

| Variable                       | Value                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| `STORAGE_DRIVER`               | `s3`                                                       |
| `STORAGE_S3_ENDPOINT`          | `https://<Cloudflare-account-id>.r2.cloudflarestorage.com` |
| `STORAGE_S3_REGION`            | `auto`                                                     |
| `STORAGE_S3_BUCKET`            | production bucket name                                     |
| `STORAGE_S3_ACCESS_KEY_ID`     | production bucket-scoped access key ID                     |
| `STORAGE_S3_SECRET_ACCESS_KEY` | production bucket-scoped secret                            |

Never use a public bucket. The app authorizes upload/download through signed requests. Follow the repository storage guide for CORS, lifecycle, alerts, budget and smoke tests. R2 usage can be billed to the payment method attached to Cloudflare, so keep the configured usage alert and review the cost register.

## 8. Trigger.dev background jobs

Follow [Trigger.dev setup](trigger-setup.md). Create/use the Madeora project and configure its **Production** environment with:

| Variable                         | Value                                          |
| -------------------------------- | ---------------------------------------------- |
| `APP_ENV`                        | `production`                                   |
| `SUPABASE_URL`                   | production Supabase project URL                |
| `SUPABASE_SERVICE_ROLE_KEY`      | production Supabase secret key (`sb_secret_…`) |
| `EMAIL_TRANSPORT`                | `resend`                                       |
| `EMAIL_FROM`                     | `Madeora <no-reply@mail.madeora.studio>`       |
| `RESEND_API_KEY`                 | production app sending key from Resend         |
| `APP_URL`                        | `https://www.madeora.studio`                   |
| `STORAGE_DRIVER`, `STORAGE_S3_*` | same production R2 values from step 7          |

Deploy the jobs from `packages/jobs` at the same commit as the production app. Confirm the expected tasks and schedules appear in Trigger.dev. If the email or storage provider is not enabled for the release, follow the feature guide and leave its transport/driver off; do not enter placeholder credentials.

## 9. Vercel Production environment variables

In Vercel project `madeora` → **Settings → Environment Variables**, ensure variables are scoped to **Production only** unless specified otherwise. Production must never inherit Preview credentials.

| Variable                               | Value / scope                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_EXPERIMENTAL_COREPACK`         | `1`; Production and Preview                                                                                            |
| `APP_ENV`                              | `production`                                                                                                           |
| `NEXT_PUBLIC_APP_URL`                  | `https://www.madeora.studio`                                                                                           |
| `NEXT_PUBLIC_SUPABASE_URL`             | production Supabase URL ending in `.supabase.co`                                                                       |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production `sb_publishable_…` key                                                                                      |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`       | production Turnstile Site Key                                                                                          |
| `EMAIL_TRANSPORT`                      | `resend` after Trigger.dev email delivery is configured; otherwise `off`                                               |
| `STORAGE_DRIVER`, `STORAGE_S3_*`       | production R2 settings after R2 setup; otherwise `off`                                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`            | production Supabase secret key; server-only, required for the storage upload finalization path when storage is enabled |

Do not set `EMAIL_FROM`, `RESEND_API_KEY`, Trigger.dev tokens, database passwords, Turnstile secret keys, or Google OAuth client secrets in Vercel. Do not expose the Supabase secret key using a `NEXT_PUBLIC_` name.

Check the environment scope for each Supabase variable: Preview values point to `madeora-preview`, while Production values point to `madeora-production`. Existing production variables take effect only in a new deployment.

## 10. Apply the database migrations

A new, empty production database must receive every migration in chronological order before deploying code that uses them. Use [production migrations](production-migrations.md): either run the consolidated copyable SQL once on an empty database, or apply each individual migration once in order. Never run both paths. For later releases, apply only new migrations, oldest first, before merging the release PR into `production`.

Check the verification queries in [Supabase migrations](supabase-migrations.md) and the migration guide. Stop on any SQL error; do not continue to later files.

## 11. First release to Production

1. Confirm the required Supabase migrations have been applied and the database verification checks pass.
2. Confirm Turnstile, domain, environment variables and any enabled Google, email, storage and job integrations are configured.
3. Open the release PR from `main` into `production` using [the release procedure](github-setup.md#d-how-a-release-works-production-deploys-since-s06b-adr-0008).
4. Review the exact diff and commits, wait for every check including **Release source**, then merge the PR.
5. In Vercel → **Deployments**, confirm the `production` deployment is **Ready** and **Current**.
6. Deploy Trigger.dev jobs from the same commit (if not already deployed).

## 12. Production smoke checks

Use a private browser window and the canonical production URL.

- The sign-in page loads without a Vercel login and displays the Turnstile check.
- Sign in with the owner account; verify the dashboard loads, then sign out.
- Try sign-up only if it is intentionally enabled. If disabled, it should report that new accounts cannot be created.
- Verify password recovery and confirmation emails arrive from `no-reply@mail.madeora.studio` before enabling public sign-up.
- If Google sign-in is enabled, complete one Google sign-in and verify the linked method in Settings.
- If storage is enabled, upload and read a profile picture; check the storage quota and confirm files remain private.
- If background jobs are enabled, run the `sample-ping` smoke test and check the outbox status.
- Preview deployments must still require Vercel Authentication and must point only at `madeora-preview`.

## Ongoing operation

- **Releases:** release only through a reviewed `main` → `production` PR. Apply new SQL files before merge. Do not change the Vercel Production Branch.
- **Supabase inactivity:** Free projects may pause after a week without use. Restore `madeora-production` in Supabase if paused; investigate errors after restoration.
- **Rollbacks:** use Vercel Instant Rollback for an urgent rollback, then fix source and release through Git. A rollback does not reverse a database migration; migrations are forward-only. Never run the destructive reset section in [production migrations](production-migrations.md) as a rollback.
- **Secrets:** rotate credentials in their provider, update only the intended environment, then redeploy the app/jobs. Keep preview and production credentials separate.
- **Costs and limits:** review [provider cost register](provider-cost-register.md), including Vercel commercial-use limits, Supabase quotas, Resend email quotas, Trigger.dev usage and Cloudflare R2 billing.
- **Service-specific runbooks:** [email](email-setup.md), [file storage](file-storage.md), [background jobs](background-jobs.md), [staff operations](staff-operations.md), and [Google sign-in](google-sign-in-setup.md).

## Never put these in Git, chat or browser-visible variables

Supabase database password or secret/service-role key, Turnstile secret, Resend API key, R2 secret access key, Trigger.dev access token, Google OAuth client secret. Store each secret only in the provider/environment named by its guide.
