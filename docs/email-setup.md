# Email from madeora.studio: owner guide

Madeora sends two kinds of email:

- **Account emails** (confirmations and password resets). Supabase Auth sends these through Resend's SMTP.
- **Invitation and notification emails** (S10, S14). The app queues these in the database and Trigger.dev jobs send them through Resend's API ([ADR 0018](adr/0018-notifications-core.md)).

Both come from **`no-reply@mail.madeora.studio`**. This guide verifies that domain in Resend, points the account emails at it, and gives the app its own keys. Everything is free. If Resend, Vercel or your registrar asks for a card at any point, stop and tell Claude (€0 rule). Background: [ADR 0012](adr/0012-invitations-and-join-requests.md).

**Why a subdomain:** Resend's free plan allows **one** sending domain. Sending from `mail.madeora.studio` keeps email reputation separate from the website, and leaves the root domain free. Previews and production share the one domain, but each has its own API keys and sender name.

**What you need:**

- Your Resend login.
- Access to the DNS settings of `madeora.studio`, and Vercel access.

DNS is managed either at the company you bought the domain from, or at Vercel if the domain's nameservers point to Vercel. To find out which:

1. Open https://vercel.com and open the **madeora** project.
2. Click **Settings**, then **Domains**.
3. If `madeora.studio` shows "Nameservers: Vercel", manage DNS at Vercel (step 2b). Otherwise manage it at your registrar (step 2a).

Already did steps 1 to 4 from the earlier guide (`wip/S10/resend-domain-setup.md`)? Skip to step 5.

## 1. Add the domain in Resend

1. Open https://resend.com/domains and sign in.
2. Click **Add Domain**.
3. **Name:** type `mail.madeora.studio`.
4. **Region:** choose **Ireland (eu-west-1)**, so mail processing stays in the EU.
5. Click **Add**.
6. Resend shows a table of DNS records: usually one **MX** and two **TXT** (one for DKIM, starting `p=`), plus an optional **DMARC** TXT. Keep this page open.

## 2. Add the records to the domain's DNS

Copy each record from Resend's table **exactly**, using the copy buttons. The **Name** column shows the part before `madeora.studio` (for example `send.mail` or `resend._domainkey.mail`); type only that part.

### 2a. At your registrar

1. Sign in at the company where you bought `madeora.studio` and open its **DNS** page. It may be called "DNS records" or "Manage DNS".
2. For each row in Resend's table, click **Add record** and fill in:
   - **Type:** as in Resend (`MX` or `TXT`).
   - **Name / Host:** the Name from Resend.
   - **Value / Content:** the Value from Resend.
   - **Priority** (MX only): the number from Resend, normally `10`.
   - **TTL:** leave the default.
3. Save each record.

### 2b. At Vercel (only if Vercel manages the nameservers)

1. Open https://vercel.com, click **Domains** in the top menu, then click `madeora.studio`.
2. Under **DNS Records**, for each row in Resend's table:
   1. Fill in **Name**, **Type** and **Value**, and for MX the **Priority**.
   2. Click **Add**.

Do **not** change or remove the existing records for `www` or the root domain; those serve the website.

## 3. Verify in Resend

1. On https://resend.com/domains, click `mail.madeora.studio`, then **Verify DNS Records**.
2. Verification can take from a few minutes to a few hours. Refresh later if a record still says "Pending".

Check: every record and the domain itself show **Verified**.

## 4. Point Supabase's account emails at the domain

Do this in both Supabase projects. Only the sender changes; the SMTP password (the existing Resend key) stays.

1. Open https://supabase.com/dashboard and open **madeora-preview**.
2. Click **Authentication**, then **Emails**, then **SMTP Settings**.
3. **Sender email:** replace `onboarding@resend.dev` with `no-reply@mail.madeora.studio`.
4. **Sender name:** `Madeora Preview`.
5. Click **Save changes**.
6. Repeat 1 to 5 in **madeora-production**, with **Sender name** `Madeora`.

Check: on a preview, use **Forgot password** with a second mailbox you can read. The reset email arrives there from `no-reply@mail.madeora.studio`. Before this change it could only reach your own address.

## 5. Create the app's two API keys

The app gets its own keys, separate from the Supabase SMTP keys, so each can be revoked alone. Each key can only send, and only from this domain.

1. Open https://resend.com/api-keys and click **Create API Key**.
2. Fill in:
   - **Name:** `madeora-preview-app`
   - **Permission:** `Sending access`
   - **Domain:** `mail.madeora.studio`
3. Click **Add**, copy the key (it starts with `re_`) and keep it for step 6. Resend shows it only once.
4. Repeat 1 to 3 with **Name** `madeora-production-app`. Keep this key apart from the preview key.

## 6. Give the keys to Trigger.dev (and one flag to Vercel)

Since S14 the app queues each email in the database and a Trigger.dev job sends it, so the **Resend keys live in Trigger.dev, not in Vercel**. Vercel only needs to know that email is on, so the invitation form offers "by email". Set up Trigger.dev first ([`trigger-setup.md`](trigger-setup.md), steps 1 to 4).

1. Open https://cloud.trigger.dev, open the **madeora** project, then **Environment Variables**.
2. For **Production**, add these (the values are hidden once saved):

   | Key               | Value                                                   |
   | ----------------- | ------------------------------------------------------- |
   | `EMAIL_TRANSPORT` | `resend`                                                |
   | `EMAIL_FROM`      | `Madeora <no-reply@mail.madeora.studio>`                |
   | `RESEND_API_KEY`  | the `madeora-production-app` key from step 5            |
   | `APP_URL`         | the production address, `https://` and no trailing path |

3. If the environment list also has **Staging** on the free plan, add the same four with the `madeora-preview-app` key, `Madeora Preview <no-reply@mail.madeora.studio>` and the address of a preview you want links to open. If it has not, previews queue emails that no job sends: the invitation shows **Sending** and stays so. Nothing else breaks.
4. In Vercel (https://vercel.com/dashboard, **madeora**, **Settings**, **Environment Variables**), set `EMAIL_TRANSPORT` = `resend` for **Preview** and for **Production**. **Delete** `EMAIL_FROM` and `RESEND_API_KEY` from Vercel if they are there from S10: the web app no longer reads them, and a key that nothing uses should not be in Vercel. New values apply to new deployments; for production open **Deployments**, click **⋯** next to the newest Production deployment, then **Redeploy**.
5. Re-deploy the jobs so they carry the email code: `docs/trigger-setup.md`, step 4.

Check: Trigger.dev lists the four variables under Production, Vercel lists only `EMAIL_TRANSPORT` for email, and `RESEND_API_KEY` appears nowhere in Vercel. If a job run fails at once with a message naming `APP_URL`, `EMAIL_FROM` or `RESEND_API_KEY`, one value is missing or mistyped; the message names the variable but never shows its value.

## 7. Try it

1. Open a preview of the S10 pull request and sign in.
2. Open a Home, click **Invite people**, choose **Email invitation**, enter a second mailbox you can read, and click **Send invitation**.
3. The page says "Invitation on its way to …", and the invitation's email status is **Sending**.
4. Wait up to 5 minutes (the jobs run on a 5-minute schedule) and reload the page: the status is **Sent**.

Check: the email arrives from **Madeora Preview** (or **Madeora** in production) `<no-reply@mail.madeora.studio>`, and its button opens the invitation. If the status stays **Sending** for more than 10 minutes, open Trigger.dev, **Runs**, and look for a failed `invitation-email` run (`docs/background-jobs.md`, "Recovery runbook"). If it says **Not sent**, check step 6 for that environment, then use **Resend** on the invitation.

## 8. Open production sign-up

You chose to let anyone create an account on production (ADR 0012). Do this only when all three are true: steps 1 to 4 are done, the S10 release is live on production (so the confirmation email reaches new people), and you have approved the separate pull request that updates the "demo data only" line in `CLAUDE.md`.

1. Open https://supabase.com/dashboard and open **madeora-production**.
2. Click **Authentication**, then **Sign In / Providers**.
3. Under **User Signups**, turn **Allow new users to sign up** **on**. Leave **Confirm email** on.
4. Click **Save**.

Check: in a private window, open https://www.madeora.studio/sign-up and create an account with a second mailbox you can read. The confirmation email arrives from **Madeora** `<no-reply@mail.madeora.studio>`, and its link signs you in. To close sign-up again later, turn the same switch off.
