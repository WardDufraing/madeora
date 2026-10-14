# Vercel previews: owner setup

One-time setup for the owner (Ward) after the S04b pull request is on GitHub. It costs nothing and asks for no card. Background: `docs/adr/0005-early-previews.md`.

## 1. Create the Vercel account

1. Open https://vercel.com/signup.
2. Choose **Hobby** ("I'm working on personal projects") and type your name.
3. Click **Continue with GitHub** and sign in as `WardDufraing`. Approve the "Authorize Vercel" screen.
4. If Vercel asks for a card or offers a Pro trial, skip it. Hobby never needs one.

Check: the top-left of https://vercel.com/dashboard shows your name with the label **Hobby**.

## 2. Import the repository

1. Open https://vercel.com/new.
2. Under **Import Git Repository**, click **Install** (or **Adjust GitHub App Permissions**) if `madeora` is not listed. On GitHub, pick **Only select repositories**, choose `WardDufraing/madeora`, and click **Install**.
3. Back on https://vercel.com/new, click **Import** next to `madeora`.
4. Fill in the form:
   - **Project Name:** `madeora`
   - **Framework Preset:** `Next.js`
   - **Root Directory:** click **Edit**, select `apps/web`, click **Continue**.
   - **Build and Output Settings:** leave as they are (`apps/web/vercel.json` sets them).
   - **Environment Variables:** add one. Key `ENABLE_EXPERIMENTAL_COREPACK`, value `1`. Click **Add**.
5. Click **Deploy**.

This first deployment builds `main` as "production". Vercel shows it as **Canceled**, because `apps/web/vercel.json` skips every production build that is not from the `production` branch (its Ignored Build Step). That is correct. The next step stops Vercel treating `main` as production.

## 3. Make `production` the production branch

1. Open the project at https://vercel.com/dashboard, click **madeora**, then **Settings** in the sidebar.
2. Click **Environments**, then **Production**.
3. Under **Branch Tracking**, change the branch from `main` to `production` and click **Save**.

Check: the Production environment page shows branch `production`.

## 4. Lock previews to you

1. In **Settings**, click **Deployment Protection**.
2. Make sure **Vercel Authentication** is **Enabled** and the scope is **Standard Protection**. Click **Save** if you changed anything.
3. Do not turn on Password Protection; it is paid.

## 5. Check that previews work

1. Open the S04b pull request on GitHub (branch `chore/vercel-previews`). Within a few minutes a **Vercel** comment and check appear. If they do not, open **Deployments** in Vercel, click **Create Deployment**, type `chore/vercel-previews` and click **Create Deployment** again.
2. Click **Visit Preview**. The Madeora page opens, because you are signed in to Vercel.
3. Copy the preview link and open it in a private browser window. You should see a Vercel login page instead of Madeora. That proves strangers cannot open it.
4. After the pull request is merged, **Deployments** shows a new **Preview** for `main`. The only **Production** entry is the canceled one from step 2; you may delete it (click the **⋯** next to it, then **Delete**).

## What not to add

No other environment variables, except the two public Supabase values for the preview project that `docs/supabase-preview-setup.md` adds (S06), and the Production-only values that `docs/production-setup.md` adds (S06b). Previews hold synthetic data only and must never get production credentials, a Supabase secret key, or R2, Resend or Trigger.dev credentials until a later step says exactly which non-production values to add.
