# Supabase for previews: owner setup

One-time setup for the owner (Ward), so Vercel previews can create accounts and sign in. It uses a free Supabase project that holds synthetic test accounts only and is used by nothing else. It costs nothing and should not ask for a card; if Supabase asks for one at any point, stop and tell Claude (€0 rule). Background: `docs/adr/0007-accounts-and-preview-database.md`.

Do this after the S06 pull request is open and Vercel has built its preview, because that preview is what you test with.

## 1. Create the Supabase account and organization

1. Open https://supabase.com/dashboard/sign-up.
2. Click **Continue with GitHub** and sign in as `WardDufraing`. Approve the "Authorize Supabase" screen.
3. If Supabase asks you to create an organization:
   - **Name:** `Madeora`
   - **Type:** `Personal`
   - **Plan:** `Free - $0/month`
   - Click **Create organization**.

Check: https://supabase.com/dashboard/org shows the organization `Madeora` with the label **Free**.

## 2. Create the preview project

1. On https://supabase.com/dashboard/projects click **New project**.
2. Fill in the form:
   - **Organization:** `Madeora`
   - **Project name:** `madeora-preview`
   - **Database password:** click **Generate a password**. You will not need it for this step; Supabase keeps it in the project settings. Do not paste it anywhere else.
   - **Region:** `Central EU (Frankfurt)` (`eu-central-1`)
3. Click **Create new project** and wait until the project page stops showing "Setting up project".

Check: the project page header says `madeora-preview` and the organization still says **Free**.

## 3. Sign-in settings

1. In the left sidebar click **Authentication**, then **Sign In / Providers** (older dashboards: **Providers**, then **Email**).
2. Under **Email**:
   - **Enable email provider** (or "Enable Email Signup"): on.
   - **Confirm email:** on.
   - **Minimum password length:** `12`
   - **Password requirements:** `No required characters (default)`
   - **Prevent use of leaked passwords:** leave off (it is a paid feature).
3. Under **User Signups**, make sure **Allow new users to sign up** is on.
4. Click **Save** (each section may have its own **Save** button).

Check: reopen the page; Confirm email is on and the minimum length shows 12.

## 4. Allowed addresses

Email links always lead to a preview's **branch address**, the one with `-git-` in it. Supabase only sends links to addresses on its list, so each branch you want to test sign-up or password reset on gets its own entry. Use exact addresses, never a wildcard such as `madeora-*`: anyone on Vercel could create a project whose address matches a wildcard and receive your links.

First find the branch addresses:

1. Open https://vercel.com/dashboard, click **madeora**, then **Deployments**.
2. Click the newest preview of `feat/email-password-accounts`. Under **Domains**, copy the address with `-git-` in it, for example `https://madeora-git-feat-email-password-accounts-warddufraings-projects.vercel.app`.
3. Do the same for the newest preview of `main`, for example `https://madeora-git-main-warddufraings-projects.vercel.app`. (If `main` has no preview yet, write the address the same way as the example: only the part after `-git-` and before `-warddufraings-projects` changes.)

Then in Supabase:

1. Click **Authentication**, then **URL Configuration**.
2. **Site URL:** paste the `main` branch address and click **Save**.
3. Under **Redirect URLs** click **Add URL**, paste the `main` branch address followed by `/**` (for example `https://madeora-git-main-warddufraings-projects.vercel.app/**`) and click **Save URLs**.
4. Click **Add URL** again, paste the `feat/email-password-accounts` branch address followed by `/**` and click **Save URLs**.

Check: the Redirect URLs list shows exactly those two entries, each ending in `/**`, and no `*` anywhere else.

Later: to test sign-up or reset on another pull request, add that branch's address the same way, and remove it once the pull request is merged.

## 5. Send email through Resend

Supabase only lets you edit email templates once the project sends through your own SMTP server. Resend's free plan (3,000 emails a month, 100 a day) provides one. Without a domain of your own, Resend sends only from its test address `onboarding@resend.dev`, and only to the email address of your Resend account, which is all previews need. Buying a domain costs money, so do not add one now.

1. Open https://resend.com/signup and sign up with `warddufraing@gmail.com` (or **Continue with GitHub**, as long as the account's email is `warddufraing@gmail.com`). If Resend asks for a card or offers a paid trial, stop and tell Claude.
2. In Resend click **API Keys** in the sidebar, then **Create API Key**:
   - **Name:** `madeora-preview-supabase`
   - **Permission:** `Sending access`
   - **Domain:** `All domains`
   - Click **Add**, then copy the key (it starts with `re_`). Resend shows it only once. Do not save it anywhere except the Supabase **Password** field below.
3. In Supabase click **Authentication**, then **Emails**, then the **SMTP Settings** tab, and turn on **Enable Custom SMTP**.
4. Fill in:
   - **Sender email:** `onboarding@resend.dev`
   - **Sender name:** `Madeora Preview`
   - **Host:** `smtp.resend.com`
   - **Port number:** `465`
   - Leave any other field (such as the minimum interval between emails) as it is.
   - **Username:** `resend`
   - **Password:** paste the API key
   - Click **Save changes**.
5. Supabase now limits sign-in emails to 30 an hour (**Authentication**, **Rate Limits**, "Rate limit for sending emails"). Leave it at 30.

Check: Supabase shows **Custom SMTP** as enabled, and the **Templates** tab now lets you edit the templates. If Supabase or Resend refuses the `onboarding@resend.dev` sender, stop and tell Claude.

## 6. Email templates

1. Click **Authentication**, then **Emails** (older dashboards: **Email Templates**).
2. Click **Confirm signup**.
   - **Subject:** `Confirm your Madeora email address`
   - **Body:** delete everything in the box, then paste the full contents of [`supabase/templates/confirmation.html`](../supabase/templates/confirmation.html) from the pull request (on GitHub open the file, click **Raw**, select all and copy).
   - Click **Save changes**.
3. Click **Reset Password** (or **Reset password**).
   - **Subject:** `Reset your Madeora password`
   - **Body:** delete everything, then paste the full contents of [`supabase/templates/recovery.html`](../supabase/templates/recovery.html).
   - Click **Save changes**.

Check: each template's source contains `token_hash={{ .TokenHash }}`, and its preview shows a heading and one link.

## 7. Give previews the two public values

Both values are public by design (they end up in the browser). Never copy the **Secret key** or the database password anywhere.

1. In Supabase click **Project Settings** (gear icon), then **API Keys**. Under **Publishable key** click the copy icon next to the key that starts with `sb_publishable_`.
2. In a new tab open https://vercel.com/dashboard, click **madeora**, **Settings**, then **Environment Variables**.
3. Add the first variable:
   - **Key:** `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - **Value:** paste the publishable key
   - **Environments:** tick **Preview** only (untick Production and Development)
   - Click **Save**.
4. Back in Supabase click **Project Settings**, then **Data API**, and copy the **Project URL** (it looks like `https://abcdefghijklmnop.supabase.co`).
5. In Vercel add the second variable the same way:
   - **Key:** `NEXT_PUBLIC_SUPABASE_URL`
   - **Value:** paste the Project URL
   - **Environments:** **Preview** only
   - Click **Save**.
6. Values only reach new builds. In Vercel click **Deployments**, click **⋯** next to the newest preview of `feat/email-password-accounts`, choose **Redeploy** and confirm.

Check: the redeployed preview opens on the sign-in page instead of an error page.

## 8. Check that it works

Resend's test sender only delivers to your own address, so test with `warddufraing@gmail.com`. The emails come from `onboarding@resend.dev`; if one is missing, check Gmail's spam folder.

1. Open the S06 preview at its branch address (step 4), click **Create an account**, enter `warddufraing@gmail.com` and a password of at least 12 characters, and click **Create account**.
2. Open the email "Confirm your Madeora email address" in Gmail and click **Confirm my email address**. On the page that opens, click the **Confirm my email address** button. You land on the dashboard.
3. Click **Sign out**, then sign in again with the same address and password.

Check: in Supabase, **Authentication**, **Users** lists `warddufraing@gmail.com` with a confirmation date. To start over, click **⋯** next to the user and choose **Delete user**.

## What not to add

- No Supabase **Secret key**, `service_role` key, database password or Resend API key in Vercel, in the repository or anywhere else. The Resend key belongs only in Supabase's SMTP settings. The app refuses to start with a secret-looking key in a public variable.
- No real household data in this project: it is for trying out previews only.
- The project pauses after a week without use. To wake it, open it in the Supabase dashboard and click **Restore project**; nothing is lost.
