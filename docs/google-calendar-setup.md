# Google Calendar: owner guide

S33 lets each person connect their Google Calendar in **Settings › Google Calendar**; S34 lets them change those events from Madeora ([ADR 0044](adr/0044-google-calendar-outbound-conflicts.md)). The code works without any of the steps below: until the three variables are set, that page says "Google Calendar is not available in this environment yet" and nothing contacts Google. Background: [ADR 0043](adr/0043-google-calendar-connect.md).

Everything here is free: the Google Calendar API has no charge and needs no billing account. If Google asks for a card, a billing account or the free trial at any point, **stop and tell Claude** (€0 rule).

This uses a **new, separate** Google Cloud project, not the `Madeora` project of Google sign-in ([`google-sign-in-setup.md`](google-sign-in-setup.md)). Keeping them apart means sign-in never shows the calendar permissions or Google's "unverified app" warning.

## What you need at hand

- The app address of each environment you set up, without a trailing slash: the preview address you test with (for example `https://madeora-git-feat-google-calendar-connect-<you>.vercel.app` or your fixed preview domain) and `https://madeora.studio` for production.
- A terminal with `openssl` (macOS and Linux have it; on Windows use Git Bash).

## 1. Apply the migration

Apply `supabase/migrations/20261119090000_google_calendar.sql` exactly as described in [`docs/supabase-migrations.md`](supabase-migrations.md) ("Apply a migration"): on `madeora-preview` when the S33 pull request is ready for testing, on `madeora-production` just before you merge the release that contains it. Then run "Check S33 Google Calendar" from that guide. For S34, apply `supabase/migrations/20261120090000_google_calendar_outbound.sql` the same way, after the S33 file, and run "Check S34 Google Calendar changes". S34 needs no new variable, scope or Google setting: the `calendar.events` permission from step 2 already allows writing.

## 2. Create the project and turn on the Calendar API

1. Open https://console.cloud.google.com/ and sign in with your Madeora admin Google account. **Do not** start the free trial or add billing if a banner offers it.
2. Click the project picker at the top left (next to "Google Cloud"), then **New project**.
3. **Project name:** `Madeora Calendar`. Leave **Location** as is. Click **Create**, then **Select project** in the notification.
4. In the search bar at the top type `Google Calendar API`, open it (Marketplace result), and click **Enable**.

Check: the project picker shows `Madeora Calendar`, and the Google Calendar API page shows **API Enabled** (or a **Manage** button). No billing prompt appeared; if one did, stop and tell Claude.

## 3. Set up the consent screen (Google Auth Platform)

1. Search `Google Auth Platform` and open it. If it says "not configured yet", click **Get started**.
2. **App information:** **App name** `Madeora Calendar`; **User support email** your address. **Next**.
3. **Audience:** **External**. **Next**.
4. **Contact information:** your address. **Next**, tick the agreement, **Continue**, **Create**.
5. Left menu **Data Access** › **Add or remove scopes**. In the filter, find and tick exactly these two:
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events`

   (If a scope is not in the list, paste its address in **Manually add scopes** and click **Add to table**.) Click **Update**, then **Save**. They appear under "Your sensitive scopes"; that is expected.

6. Left menu **Audience**. Leave **Publishing status** on **Testing**. Under **Test users** click **Add users**, enter your own Gmail address and every address that should be able to connect (up to 100), and **Save**. Do **not** click **Publish app**: that needs Google's verification of the sensitive scopes, which comes before public launch.

Check: **Audience** shows **Testing**, **External** and your test users; **Data Access** lists exactly the two calendar scopes.

Note: in Testing, Google ends the connection after 7 days. Madeora then shows "Google access expired" with a **Reconnect** button; events stay visible. Reconnecting takes two clicks.

## 4. Create the web client

1. Left menu **Clients** › **Create client**. **Application type:** **Web application**. **Name:** `Madeora Calendar web`.
2. Leave **Authorized JavaScript origins** empty.
3. Under **Authorized redirect URIs** click **Add URI** once per environment and enter the app address followed by `/api/v1/integrations/google-calendar/callback`, for example:
   - `https://madeora.studio/api/v1/integrations/google-calendar/callback`
   - your preview address + `/api/v1/integrations/google-calendar/callback`
   - for local development, `http://localhost:3000/api/v1/integrations/google-calendar/callback`
4. Click **Create**. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`) into a safe place now: the secret is shown in full only once.

Check: **Clients** lists `Madeora Calendar web`, and opening it shows the redirect URIs exactly as typed (https, no trailing slash).

## 5. Generate the token key

In a terminal, run once **per environment** (preview and production get different keys):

```sh
openssl rand -base64 32
```

It prints 44 characters ending in `=`. This key encrypts the stored Google tokens. Keep it with your secrets; if it is ever changed, everyone has to reconnect.

## 6. Set the variables in Vercel

1. Open https://vercel.com/dashboard, project **madeora**, **Settings** › **Environment Variables**.
2. Add, each with the **Sensitive** option on:
   - `GOOGLE_CALENDAR_CLIENT_ID` = the Client ID from step 4
   - `GOOGLE_CALENDAR_CLIENT_SECRET` = the Client secret from step 4
   - `GOOGLE_CALENDAR_TOKEN_KEY` = the key from step 5

   Set them for **Preview** with the preview key, and for **Production** with the production key (add each variable twice, one per environment, if the keys differ).

3. New values apply to new deployments: open **Deployments**, click **⋯** next to the newest deployment of that environment, then **Redeploy**.

## 7. Set the same variables in Trigger.dev

The sync job runs in Trigger.dev and needs the same three values as the web app of that environment (the **same** token key, or it cannot read the tokens).

1. Open https://cloud.trigger.dev, project **madeora**, **Environment Variables**.
2. For **Production**, add `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` and `GOOGLE_CALENDAR_TOKEN_KEY` with the production values. If you set up **Staging** for previews ([`trigger-setup.md`](trigger-setup.md) step 3), add the preview values there.
3. Deploy the tasks again so the new job is included: [`trigger-setup.md`](trigger-setup.md) step 4 (`pnpm dlx trigger.dev@4.6.4 deploy --env prod` from `packages/jobs`).

Check: the three variables are listed with hidden values, and the Trigger.dev **Tasks** page lists `google-calendar-sync`.

## 8. Try it

1. Sign in to the app as one of your test users and open **Settings › Google Calendar** (or **Settings**, card **Google Calendar**, **Manage Google Calendar**).
2. Click **Connect Google Calendar**. Google shows "Google hasn't verified this app": click **Continue** (expected in Testing). Tick both calendar permissions and click **Continue**.
3. You return to the page with "Google Calendar is connected". Within about 5 minutes (the next dispatcher run) the account shows "Last synced …" and your calendars are listed, with the primary one syncing and shown on your personal calendar.
4. Open **Calendar**: your Google events appear, marked "From Google Calendar". Opening one of yours shows **Edit** and **Delete** (other people see it read-only).
5. (S34) Click **Edit**, change the title and save: the event shows "Your changes are waiting to be saved to Google". Within about 5 minutes (or after **Sync now** in Settings) the message is gone and Google Calendar shows the new title. Add an event from **Calendar › New event** with **Save to** set to a Google calendar: it appears in Google after the next sync.
6. (S34) To see a conflict: edit an event's title in Madeora, then, before the next sync, change the same title in Google Calendar. After **Sync now** the event page shows both versions and waits until you click **Keep Madeora's version** or **Keep Google's version**.
7. To share a calendar with a Home, tick that Home under the calendar and click **Save**; another member of that Home then sees its events (except ones marked private in Google).

If the page says "This connect attempt expired or did not match", start again from the page (do not reuse an old Google tab). If it says "Google did not give Madeora access to your calendars", connect again and leave both permissions ticked. If Google shows `redirect_uri_mismatch`, compare the redirect URI in step 4 with the address in your browser, character for character.
