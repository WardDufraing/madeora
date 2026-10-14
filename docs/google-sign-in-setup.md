# Google sign-in on the hosted Supabase projects: owner guide

S08 adds **Continue with Google** to the sign-in and sign-up pages, and **Settings › Sign-in methods** to link or unlink Google. The code works without any of the steps below: until Google is switched on in a Supabase project, the pages connected to it simply show no Google button, and Settings says "Google sign-in isn't switched on here yet." Background: [ADR 0010](adr/0010-google-sign-in.md).

Everything here is free: a Google Cloud project with an OAuth client for basic sign-in (name, email address) needs no billing account and no card. If Google asks you for a card or to enable billing at any point, **stop and tell Claude** (€0 rule).

Do the steps in this order. **Step 1 must come before step 4**: the migration is what stops Supabase from attaching Google to an existing account just because the email address matches.

## What you need at hand

- The **Supabase project address** of `madeora-preview` (and later `madeora-production`), for example `https://abcdefghijklmnop.supabase.co`. Supabase: **Project Settings** › **Data API**, the part up to `.supabase.co`.
- A Google account you use for Madeora administration (your own is fine).

## 1. Apply the migration

Apply `supabase/migrations/20261015090000_sign_in_methods.sql` exactly as described in [`docs/supabase-migrations.md`](supabase-migrations.md) ("Apply a migration"): on `madeora-preview` when the S08 pull request is ready for testing (from its branch `feat/google-sign-in`), on `madeora-production` just before you merge the release that contains it.

If the SQL Editor answers with an error that mentions `auth.identities` (for example "must be owner of table identities"), **stop**: do not enable Google on that project, and send Claude the error text. Supabase is expected to allow these triggers, but this is the first time Madeora uses them on a hosted project.

Then run the S08 check from that guide ("Check S08").

## 2. Create the Google Cloud project

1. Open https://console.cloud.google.com/ and sign in with your Google account. Accept the terms if asked. **Do not** start the "free trial" or add a billing account if a banner offers it; it is not needed.
2. At the top left, click the project picker (next to "Google Cloud"), then **New project**.
3. **Project name:** `Madeora`. **Location / Organization:** leave as is (`No organization` is fine). Click **Create**.
4. When the notification says the project is created, click **Select project**.

Check: the project picker at the top shows `Madeora`.

## 3. Set up Google's sign-in screen (Google Auth Platform)

1. In the search bar at the top type `Google Auth Platform` and open it (older consoles: **APIs & Services** › **OAuth consent screen**). If it says "Google Auth Platform not configured yet", click **Get started**.
2. **App information:** **App name** `Madeora`; **User support email**: your address. Click **Next**.
3. **Audience:** choose **External**. Click **Next**.
4. **Contact information:** your address. Click **Next**.
5. Tick that you agree to the Google API Services User Data Policy, click **Continue**, then **Create**.
6. In the left menu click **Data Access**, then **Add or remove scopes**. Tick only `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `openid`. Click **Update**, then **Save**. Do not add any other scope: these three are "non-sensitive" and need no Google review.
7. In the left menu click **Branding**. Under **Authorized domains** click **Add domain**, type `supabase.co`, and add `madeora.studio` the same way. Leave the logo empty (a logo triggers a Google review). Click **Save**.
8. In the left menu click **Audience**.
   - For now leave **Publishing status** on **Testing**. Under **Test users** click **Add users**, type your own Gmail address (and any other address you want to test with) and click **Save**. While in Testing, only these addresses can use Google sign-in.
   - When production should accept Google sign-in from anyone (not before step 7 below works): click **Publish app** and confirm. With only the three scopes above, Google shows "verification not required". If Google says verification **is** required, stop and tell Claude.

Check: **Audience** shows User type **External** and your address under Test users; **Data Access** lists exactly the three scopes.

## 4. Create the sign-in client for `madeora-preview`

1. In the left menu click **Clients**, then **Create client** (older consoles: **Credentials** › **Create credentials** › **OAuth client ID**).
2. **Application type:** **Web application**. **Name:** `Madeora preview`.
3. Under **Authorized JavaScript origins** leave the list empty.
4. Under **Authorized redirect URIs** click **Add URI** and paste the `madeora-preview` Supabase project address followed by `/auth/v1/callback`, for example `https://abcdefghijklmnop.supabase.co/auth/v1/callback`. No trailing `/`.
5. Click **Create**. A window shows the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`). Click **Download JSON** if offered, or keep the window open for step 5.

The client secret is a secret: it goes only into Supabase (step 5). Never paste it into GitHub, Vercel, a chat or a file in the repository.

Check: **Clients** lists `Madeora preview` with type Web application.

## 5. Turn on Google in `madeora-preview`

1. Open https://supabase.com/dashboard/projects and click `madeora-preview` (restore it first if it is paused).
2. In the left sidebar click **Authentication**, then **Sign In / Providers**.
3. Under **User Signups**, turn **Allow manual linking** on and click **Save**. (Settings › Sign-in methods uses it; the migration from step 1 still decides who may link.) Leave **Allow anonymous sign-ins** off.
4. Further down, under **Auth Providers**, click **Google**.
   - **Enable Sign in with Google:** on.
   - **Client IDs:** paste the Client ID from step 4.
   - **Client Secret (for OAuth):** paste the Client secret from step 4.
   - **Skip nonce checks:** off. **Allow users without an email:** off.
   - The **Callback URL (for OAuth)** shown there must be exactly the redirect URI you entered in step 4.4.
   - Click **Save**.
5. Nothing to change under **Authentication** › **URL Configuration**: the entries ending in `/**` from the preview setup already allow Madeora's `/auth/callback` page.

Check: reopen **Google**; it shows Enabled, and the Client ID matches the one in Google Cloud.

## 6. Security emails when a sign-in method changes

Supabase can email the account's address whenever Google is linked or unlinked, so a person notices a change they did not make.

1. Still in `madeora-preview`, click **Authentication**, then **Emails** (older dashboards: **Email Templates**).
2. Open the **Security** tab (or scroll to the security notifications list). Click **Identity linked**.
   - Turn the notification **on**.
   - **Subject:** `A sign-in method was linked to your Madeora account`
   - **Body:** delete everything, then paste the full contents of [`supabase/templates/identity-linked.html`](../supabase/templates/identity-linked.html) (on GitHub open the file, click **Raw**, select all and copy).
   - Click **Save changes**.
3. Click **Identity unlinked** and do the same with the subject `A sign-in method was removed from your Madeora account` and [`supabase/templates/identity-unlinked.html`](../supabase/templates/identity-unlinked.html).

If your dashboard has no Identity linked / unlinked entries, skip this step and tell Claude; sign-in works without it.

Check: both notifications show as enabled, and each body contains `{{ .Provider }}`.

## 7. Check it on the preview

Use the preview of the S08 pull request (its branch address with `-git-feat-google-sign-in-` in it). Remember that previews send email only to your own address (Resend without a domain), and Google sign-in works only for test users while the Google project is in Testing.

1. **Link Google to your password account.** Sign in with your email and password. Open **Settings** › **Sign-in methods**, click **Link Google**, type your password, click **Confirm and go to Google**, and choose your Google account. You return to Settings with "Google is linked." and "Linked to the Google account …". Within a few minutes the email "A sign-in method was linked to your Madeora account" arrives (if you did step 6).
2. **Sign in with Google.** Click **Sign out**, then on the sign-in page **Continue with Google** and pick the same Google account. The dashboard of the same account opens (the same display name as before).
3. **Unlink.** In **Settings** › **Sign-in methods** click **Unlink Google**, type your password and confirm. You see "Google is unlinked." Signing out and trying **Continue with Google** again with that Google account now creates a new, separate account if its address is free, or fails with "Signing in with Google didn't work." if that address already belongs to your password account. That second case is intended: Madeora never joins accounts on a matching email address.
4. **A brand-new Google account** (a test user whose address has no Madeora account): **Continue with Google** on the sign-up or sign-in page creates the account and opens the personal dashboard. **Settings** › **Sign-in methods** says Google is your only way to sign in and offers no unlink.

If there is no **Continue with Google** button, re-check step 5 and wait a minute (the app re-reads the setting every minute). If Google shows "Error 400: redirect_uri_mismatch", re-check step 4.4 against the Callback URL in step 5.4. If Google says "Access blocked: Madeora has not completed the Google verification process", the address is not a test user (step 3.8).

## 8. Production (`madeora-production`)

Only when you release S08 to production:

1. Apply the migration to `madeora-production` (step 1) before merging the release pull request.
2. In Google Cloud, create a second client as in step 4, named `Madeora production`, with the redirect URI `https://<madeora-production address>/auth/v1/callback`.
3. Do steps 5 and 6 in `madeora-production` with that client's ID and secret.
4. Production keeps **Allow new users to sign up** off until S10. Then Google can only be linked to accounts you created; a Google sign-in for a Google account that is not linked to any Madeora account shows "New accounts can't be created here yet."
5. Publish the Google app (step 3.8) only when people other than the test users should use Google sign-in.

Check: on `https://www.madeora.studio`, repeat steps 7.1 to 7.3 with one of your demo accounts.

## If you need to switch Google sign-in off

In Supabase, **Authentication** › **Sign In / Providers** › **Google**: turn **Enable Sign in with Google** off and click **Save**. Accounts that were created with Google cannot sign in until it is on again; their data stays. Linked password accounts keep signing in with their password. Do **not** undo the migration while Google is enabled.

To remove a leaked client secret: in Google Cloud **Clients**, open the client, click **Add secret**, put the new secret into Supabase (step 5.4), then disable and delete the old one.
