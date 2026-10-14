# Email from madeora.studio: owner guide

Madeora sends two kinds of email:

- **Account emails** (confirmations and password resets). Supabase Auth sends these through Resend's SMTP.
- **Invitation emails** (S10). The app sends these through Resend's API.

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

## 6. Give the keys to Vercel

1. Open https://vercel.com/dashboard, click **madeora**, then **Settings**, then **Environment Variables**.
2. Add the three **Preview** variables below. For each one:
   1. Click **Add New** (or **Add Environment Variable**).
   2. Fill in **Key** and **Value**.
   3. Tick **Preview** only (untick Production and Development).
   4. For `RESEND_API_KEY`, also turn on **Sensitive**.
   5. Click **Save**.

   | Key               | Value                                            |
   | ----------------- | ------------------------------------------------ |
   | `EMAIL_TRANSPORT` | `resend`                                         |
   | `EMAIL_FROM`      | `Madeora Preview <no-reply@mail.madeora.studio>` |
   | `RESEND_API_KEY`  | the `madeora-preview-app` key from step 5        |

3. Add the same three keys again with **Production** ticked only (untick Preview and Development):

   | Key               | Value                                        |
   | ----------------- | -------------------------------------------- |
   | `EMAIL_TRANSPORT` | `resend`                                     |
   | `EMAIL_FROM`      | `Madeora <no-reply@mail.madeora.studio>`     |
   | `RESEND_API_KEY`  | the `madeora-production-app` key from step 5 |

4. New values apply to new deployments only. For previews, the next push to a pull request picks them up. For production, open **Deployments**, click **⋯** next to the newest Production deployment, then **Redeploy**.

Check: the Environment Variables list shows each of the three keys twice, once for Preview and once for Production, and the two `RESEND_API_KEY` entries have different values. If a preview or production deployment fails to start with a message naming `EMAIL_FROM` or `RESEND_API_KEY`, one value was mistyped. The message names the variable but never shows its value.

## 7. Try it

1. Open a preview of the S10 pull request and sign in.
2. Open a Home, click **Invite people**, choose **Email invitation**, enter a second mailbox you can read, and click **Send invitation**.
3. The page says "Invitation sent to …", and the invitation's email status is **Sent**.

Check: the email arrives from **Madeora Preview** `<no-reply@mail.madeora.studio>`, and its button opens the invitation in the same preview. If the status says **Not sent**, check step 6 for that environment, then use **Resend** on the invitation.

## 8. Open production sign-up

You chose to let anyone create an account on production (ADR 0012). Do this only when all three are true: steps 1 to 4 are done, the S10 release is live on production (so the confirmation email reaches new people), and you have approved the separate pull request that updates the "demo data only" line in `CLAUDE.md`.

1. Open https://supabase.com/dashboard and open **madeora-production**.
2. Click **Authentication**, then **Sign In / Providers**.
3. Under **User Signups**, turn **Allow new users to sign up** **on**. Leave **Confirm email** on.
4. Click **Save**.

Check: in a private window, open https://www.madeora.studio/sign-up and create an account with a second mailbox you can read. The confirmation email arrives from **Madeora** `<no-reply@mail.madeora.studio>`, and its link signs you in. To close sign-up again later, turn the same switch off.
