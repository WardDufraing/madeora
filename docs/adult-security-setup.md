# Adult security setup (S37)

What the owner sets in each hosted Supabase project (`madeora-preview` and, at release,
`madeora-production`) so two-factor sign-in, trusted browsers, password change, email change,
recovery methods (backup email, account recovery codes) and session management work there the
way they do in CI. Everything here is on Supabase's free plan: TOTP (authenticator
app) two-factor sign-in costs nothing. Phone (SMS) two-factor is a paid add-on and stays **off**.

Do these steps after the S37 pull request is merged and before using Settings › Security on the
preview. Repeat them for production at release.

## 1. Turn on authenticator-app two-factor sign-in

1. Open <https://supabase.com/dashboard> and choose the project.
2. Go to **Authentication → Multi-Factor** (under "Configuration").
3. Under **TOTP (App Authenticator)**, set **Enabled** (both enroll and verify).
4. Leave **Phone** off. Leave **Maximum number of factors** as it is.
5. Click **Save**.

## 2. Use one confirmation link for an email change

Madeora sends the confirmation link only to the new address and tells the old address afterwards
(spec: "the new address must confirm the change").

1. Go to **Authentication → Sign In / Providers → Email** (some dashboards: **Authentication →
   Providers → Email**).
2. Turn **Secure email change** **off**.
3. Click **Save**.

## 3. Email templates and security notifications

1. Go to **Authentication → Emails** (or **Email Templates**).
2. Open **Change Email Address**. Set the subject to `Confirm your new Madeora email address` and
   paste the whole of `supabase/templates/email-change.html` as the body. **Save**.
3. Open the **Security** (or **Notifications**) tab and turn on each of these, with the subject and
   the file named here as the body:
   1. **Password changed**: `Your Madeora password was changed`,
      `supabase/templates/password-changed.html`.
   2. **Email address changed**: `Your Madeora account email was changed`,
      `supabase/templates/email-changed.html`.
   3. **MFA factor enrolled**: `Two-factor sign-in was turned on for your Madeora account`,
      `supabase/templates/mfa-factor-enrolled.html`.
   4. **MFA factor unenrolled**: `Two-factor sign-in was turned off for your Madeora account`,
      `supabase/templates/mfa-factor-unenrolled.html`.
4. **Save** each one.

## 4. Check the request check after the migration

The S37 migration makes PostgREST run `public.check_request` before every request, so a signed-out
(revoked) session or a session still waiting for its code is refused at once. Check that the
hosted project accepted it:

1. After the migrations have run (`docs/supabase-migrations.md`), open **SQL Editor** and run:
   ```sql
   select rolconfig from pg_roles where rolname = 'authenticator';
   ```
2. The result must contain `pgrst.db_pre_request=public.check_request`.
3. If it does **not**, or the migration `20261123090100_adult_security_request_check.sql` failed
   with `permission denied to set parameter`, stop and tell Claude in the project thread (the
   other S37 migration is applied either way). Do not change the migration or the setting by hand: the
   fallback (setting it under **Database → Settings** or through Supabase support) is a decision
   for the owner, and until it is in place a revoked session keeps working until its access token
   expires (at most one hour).

## 5. Deploy the two new background jobs

The backup-address link and the account recovery emails are sent by two new Trigger.dev tasks,
`security-email` and `account-recovery-ready`. Nothing new needs configuring: they use the email
settings from `docs/email-setup.md`.

1. After the merge, deploy the tasks once, as in step 3 of `docs/trigger-setup.md`
   (`pnpm dlx trigger.dev@4.6.4 deploy --env prod`, from `packages/jobs`).
2. In the Trigger.dev dashboard, check that both tasks are listed.

"Confirm with Google" (for accounts without a password) comes back to `/auth/reauthenticate`. The
Redirect URLs entry ending in `/**` from `docs/supabase-preview-setup.md` already covers it; add
nothing.

## 6. Quick check on the preview

1. Sign in on the preview, open **Settings → Security** and turn on two-factor sign-in with an
   authenticator app. Save the recovery codes.
2. In a private window, sign in again: you are asked for a code before anything else.
3. In the first window, sign out the private window's session under **Devices and sessions**. In
   the private window, reload: you are back at sign-in.
4. Turn two-factor sign-in off again if you want; you get an email each time.
5. With two-factor sign-in on, tick **Trust this browser for 30 days** at the code step in a
   private window. Sign out and in again there: no code is asked. Under **Trusted browsers**,
   select **Stop trusting all browsers**; the next sign-in there asks for the code again.
6. Under **Recovery methods**, add a backup address you can read. Open the link from that mailbox
   while signed in: the address shows as your backup address. Create account recovery codes and
   store them.
