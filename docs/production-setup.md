# Production: owner setup

One-time setup for the owner (Ward), so production can be opened by anyone you share the link with. Everything here is free and should not ask for a card; if Supabase, Cloudflare, Resend or Vercel asks for one at any point, stop and tell Claude (€0 rule). Background: `docs/adr/0008-early-production.md`.

Do this after the S06b pull request (branch `chore/early-production`) is merged into `main`. Until step 7, nothing goes live.

Production holds **demo accounts only**: your own and accounts you create for people you show Madeora to. No real household data until the release step (S49) has decided backups and privacy.

Write down three things as you go; later steps ask for them:

- **Production address**, from step 2, for example `https://madeora.vercel.app`
- **Turnstile site key**, from step 3
- **Supabase project address** of `madeora-production`, from step 4.7, for example `https://abcdefghijklmnop.supabase.co`

The Turnstile **secret** key and the Resend API key go straight into Supabase and nowhere else.

## 1. Check that a free Supabase project slot is open

The free plan allows 2 active projects; `madeora-preview` uses one.

1. Open https://supabase.com/dashboard/projects.
2. Look at the projects in the `Madeora` organization and in any other organization you own.

Check: apart from `madeora-preview`, no other project shows as active. If another one is active (for example an old experiment), open it, click **Project Settings**, then **General**, then **Pause project**, or tell Claude if you want to keep it running.

## 2. Find the production address

1. Open https://vercel.com/dashboard, click **madeora**, then **Settings**, then **Domains**.
2. Look for an address that ends in `.vercel.app` and has no `-git-` in it, for example `madeora.vercel.app`.
3. If there is none:
   1. Click **Add Domain**.
   2. Type `madeora.vercel.app` and click **Add**. If Vercel says it is taken, try `madeora-app.vercel.app` (or another short name ending in `.vercel.app`).
   3. If Vercel asks which environment, choose **Production**.
4. Write it down with `https://` in front and nothing after it, for example `https://madeora.vercel.app`. That is the **production address**.

Check: the Domains page lists the address, connected to **Production**.

## 3. Create the Turnstile widget (Cloudflare)

1. Open https://dash.cloudflare.com/sign-up and create a free account with `warddufraing@gmail.com`. Confirm the email Cloudflare sends. You do not need to add a website or domain; skip any "add a site" screen.
2. In the Cloudflare dashboard, click **Turnstile** in the left sidebar (under **Application security** on newer dashboards).
3. Click **Add widget** and fill in:
   - **Widget name:** `madeora-production`
   - **Hostname management:** click **Add hostnames**, type the production address **without** `https://` (for example `madeora.vercel.app`), click **Add**, tick it and click **Add**.
   - **Widget Mode:** `Managed`
   - **Would you like to opt for pre-clearance for this site?** `No`
4. Click **Create**.
5. Cloudflare shows a **Site Key** and a **Secret Key**. Copy the **Site Key** and write it down. Leave this tab open; step 4.6 needs the **Secret Key**.

Check: the Turnstile page lists `madeora-production` with your production hostname.

## 4. Create the production Supabase project

### 4.1 Project

1. On https://supabase.com/dashboard/projects click **New project**.
2. Fill in:
   - **Organization:** `Madeora`
   - **Project name:** `madeora-production`
   - **Database password:** click **Generate a password**. Supabase keeps it in the project settings; do not paste it anywhere else.
   - **Region:** `Central EU (Frankfurt)` (`eu-central-1`)
3. Click **Create new project** and wait until "Setting up project" disappears.

Check: the header says `madeora-production` and the organization still says **Free**.

### 4.2 Sign-in settings

1. Click **Authentication**, then **Sign In / Providers**.
2. Under **Email**:
   - **Enable email provider:** on
   - **Confirm email:** on
   - **Minimum password length:** `12`
   - **Password requirements:** `No required characters (default)`
   - **Prevent use of leaked passwords:** leave off (paid feature)
3. Under **User Signups**, turn **Allow new users to sign up** **off**. Production stays closed to new sign-ups until real email arrives (S10); you create accounts yourself in step 5.
4. Click **Save** (each section may have its own **Save**).
5. On the same page click **Phone**. Leave **Enable Phone provider** off, make sure **Enable phone confirmations** is on, and click **Save**.

Check: reopen the page. Confirm email is on, the minimum length is 12, Allow new users to sign up is off, and under Phone, Enable phone confirmations is on.

### 4.3 Allowed addresses

1. Click **Authentication**, then **URL Configuration**.
2. **Site URL:** paste the production address and click **Save**.
3. Under **Redirect URLs**, click **Add URL**, paste the production address followed by `/**` (for example `https://madeora.vercel.app/**`) and click **Save URLs**.

Check: Redirect URLs shows exactly one entry, the production address ending in `/**`, with no other `*`.

### 4.4 Send email through Resend

Use a separate Resend key for production, so either environment's key can be revoked on its own.

1. Open https://resend.com/api-keys (you created the Resend account for previews). Click **Create API Key**:
   - **Name:** `madeora-production-supabase`
   - **Permission:** `Sending access`
   - **Domain:** `All domains`
   - Click **Add** and copy the key (starts with `re_`). Resend shows it only once.
2. In Supabase (`madeora-production`) click **Authentication**, then **Emails**, then **SMTP Settings**, and turn on **Enable Custom SMTP**.
3. Fill in:
   - **Sender email:** `onboarding@resend.dev`
   - **Sender name:** `Madeora`
   - **Host:** `smtp.resend.com`
   - **Port number:** `465`
   - **Username:** `resend`
   - **Password:** paste the key
   - Leave every other field as it is and click **Save changes**.

Check: Custom SMTP shows as enabled. Until S10, emails from production reach only `warddufraing@gmail.com`.

### 4.5 Email templates

1. Click **Authentication**, then **Emails**.
2. Click **Confirm signup**:
   - **Subject:** `Confirm your Madeora email address`
   - **Body:** delete everything, then paste the full contents of [`supabase/templates/confirmation.html`](../supabase/templates/confirmation.html) (on GitHub open the file on `main`, click **Raw**, select all, copy).
   - Click **Save changes**.
3. Click **Reset Password**:
   - **Subject:** `Reset your Madeora password`
   - **Body:** delete everything, then paste the full contents of [`supabase/templates/recovery.html`](../supabase/templates/recovery.html).
   - Click **Save changes**.

Check: each template contains `token_hash={{ .TokenHash }}`.

### 4.6 Turn on Turnstile (CAPTCHA protection)

1. Click **Authentication**, then **Attack Protection** (older dashboards: **Project Settings**, **Authentication**, **Bot and Abuse Protection**).
2. Turn on **Enable Captcha protection**.
3. **Choose Captcha Provider:** `Turnstile by Cloudflare`.
4. **Captcha secret:** paste the **Secret Key** from the Cloudflare tab (step 3.5).
5. Click **Save**.

Check: reopen the page; Captcha protection is on with Turnstile selected. Then close the Cloudflare tab. The secret key lives only here.

### 4.7 Copy the two public values

1. Click **Project Settings**, then **API Keys**. Copy the key under **Publishable key** (starts with `sb_publishable_`) and keep it for step 6. Never copy the **Secret key**.
2. Click **Project Settings**, then **Data API**, copy the address shown, and delete everything after `.supabase.co`, including any `/rest/v1/` and the last `/`. Write it down as the **Supabase project address**.

## 5. Create demo accounts

Sign-up is closed, so you create the accounts people use to look around. Start with your own.

1. In `madeora-production` click **Authentication**, then **Users**.
2. Click **Add user**, then **Create new user**.
3. Fill in:
   - **Email address:** `warddufraing@gmail.com` for your own account. For a demo account, use an address that only you receive, such as `warddufraing+demo1@gmail.com`. Until S10, reset emails reach only `warddufraing@gmail.com` itself, so a demo account cannot reset its password by email; if its password is forgotten, delete the demo user and create it again.
   - **User Password:** at least 12 characters.
   - **Auto Confirm User?** ticked.
4. Click **Create user**.

Check: the Users list shows the address. To take a demo account away later, click **⋯** next to it and choose **Delete user**.

## 6. Give Vercel the production values

1. Open https://vercel.com/dashboard, click **madeora**, **Settings**, then **Environment Variables**.
2. First check the existing ones:
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` must show **Preview** only. If either also shows Production, click **⋯**, **Edit**, untick **Production**, and click **Save**. Otherwise production would use the preview database.
   - `ENABLE_EXPERIMENTAL_COREPACK` must include **Production**. If it does not, click **⋯**, **Edit**, tick **Production**, and click **Save**.
3. Add these five variables. For each: click **Add New** (or **Add Environment Variable**), fill in **Key** and **Value**, tick **Production** only (untick Preview and Development), and click **Save**.

   | Key                                    | Value                                       |
   | -------------------------------------- | ------------------------------------------- |
   | `APP_ENV`                              | `production`                                |
   | `NEXT_PUBLIC_APP_URL`                  | the production address                      |
   | `NEXT_PUBLIC_SUPABASE_URL`             | the Supabase project address                |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the `madeora-production` publishable key    |
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`       | the Turnstile **Site Key** (not the secret) |

   Vercel may warn that `NEXT_PUBLIC_` values are visible in the browser. That is correct for these four; none of them is a secret.

4. Click **Settings**, then **Deployment Protection**. **Vercel Authentication** must stay **Enabled** with **Standard Protection**. Do not choose "All Deployments": that would lock production too.

Check: the Environment Variables list shows the two Supabase variables twice, once for Preview and once for Production, with different values.

## 7. Release to production

Every release works like this, the first one included.

1. Open https://github.com/WardDufraing/madeora/compare/production...main.
2. Click **Create pull request**. Title: `release: <today's date>`, for example `release: 2026-10-15`. Click **Create pull request**.
3. Wait until every check is green, including `Release source`.
4. Read the commit list: this is exactly what goes live.
5. Click **Merge pull request**, then **Confirm merge**.
6. In Vercel, click **Deployments**. Within a minute a deployment for branch `production` appears with the label **Production**. Wait until it says **Ready** and carries the **Current** label (the deployment the production address shows). If it is Ready but not Current, an earlier rollback is still in force: see "Undo a release" below.

If the deployment says **Error**, click it and open **Build Logs**. A line naming a variable (for example `NEXT_PUBLIC_TURNSTILE_SITE_KEY (missing)`) means step 6 is incomplete: fix the variable, then click **⋯** next to the failed deployment, choose **Redeploy** and confirm.

## 8. Check that it works

Always share exactly the production address from step 2. Vercel also serves production on longer `.vercel.app` addresses, but Turnstile only works on the hostname you gave it in step 3, so on any other address the security check fails.

1. **Public:** open the production address in a private browser window. The Madeora sign-in page opens, without a Vercel login, and shows the Turnstile check above the **Sign in** button.
2. **Sign in:** wait until Turnstile shows a tick, sign in with your own account from step 5, and you land on the dashboard. Sign out again.
3. **Sign-up closed:** in the same window click **Create an account**, enter any address and a 12-character password, wait for the tick, and click **Create account**. The page says "New accounts can't be created here yet."
4. **Supabase enforces Turnstile:** this proves a script cannot skip the check.
   1. On the production sign-in page, open the browser's developer tools (Chrome: press `F12`, or right-click the page and choose **Inspect**) and click the **Console** tab.
   2. If Chrome asks you to type `allow pasting`, type it and press Enter.
   3. Paste this, replacing the two values in quotes with your Supabase project address and publishable key, and press Enter:
      ```js
      fetch("https://abcdefghijklmnop.supabase.co/auth/v1/recover", {
        method: "POST",
        headers: { apikey: "sb_publishable_...", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com" }),
      })
        .then((r) => r.json())
        .then(console.log);
      ```
   4. The answer must contain `captcha_failed`. If it says anything else, step 4.6 is not active; check it again.
5. **Previews still private:** open any preview link (with `-git-` in it) in a private window. Vercel asks you to log in.

## Later

- **Undo a release:** in Vercel click **Deployments**, click **⋯** next to the previous **Production** deployment and choose **Instant Rollback**. Then tell Claude, so the fix goes through `main` and a new release. While a rollback is in force, Vercel builds new releases but does not put them on the production address. After the fixed release is **Ready**: open **Deployments**, click **⋯** next to it, choose **Promote** (or click **Undo Rollback** in the banner at the top of the project page), confirm, and check that it now carries the **Current** label.
- **Paused project:** a free Supabase project pauses after a week without use, and production then shows errors. Open `madeora-production` in the Supabase dashboard and click **Restore project**; nothing is lost.
- **Sign-up:** S10 brings real email. Until then keep **Allow new users to sign up** off.
- **Address changes:** if the production address ever changes, update it in Cloudflare (Turnstile hostname), Supabase (Site URL and Redirect URLs) and Vercel (`NEXT_PUBLIC_APP_URL`), then release again.

## What not to add

- No Supabase **Secret key**, `service_role` key, database password, Turnstile **Secret Key** or Resend API key in Vercel, the repository or anywhere else. The app refuses to build with a secret-looking value in a `NEXT_PUBLIC_` variable.
- No production values on Preview, and no preview values on Production.
- No real household data, until the release step says so.
