# File storage

How Madeora stores files (S15, ADR 0019), how to change storage allowances, and how to switch storage on for a hosted environment once the owner has chosen a provider. The first feature that stores files is the profile picture; task attachments (S19c, ADR 0025) are the second, in the task's pool (the person's for a Personal task, the Home's for a Home task).

## How it works

1. The browser asks `POST /api/v1/files/upload-intents` for an upload. The database checks the type and size, the rate limit and the pool's free space under a lock, reserves the space and generates an opaque key.
2. The browser puts the file straight to storage through a 5-minute signed link. Madeora never relays the bytes.
3. `POST /api/v1/files/{id}/finalize` reads the file back, checks its real size, type and signature, re-encodes it (pictures: a 512×512 WebP without metadata) and records it with `finalize_upload`, the web app's only privileged call.
4. Pictures are shown through `GET /api/v1/files/{id}/content`, which asks the database on every view whether this viewer may see the file, then redirects to a 60-second link.

Task attachments are kept in their own format: pictures are re-encoded without metadata, other files are stored as uploaded after a signature check, and anyone who may see the task may view them (images and PDFs inline, everything else as a download). Unfinished uploads expire after 15 minutes and their space is released. Replaced pictures stay recoverable and keep counting for 7 days, then a job deletes them.

## Allowances

Every person has a personal pool and every Home its own. The defaults are development placeholders (1 GiB personal, 5 GiB per Home) until the owner decides the real sizes. Change them in the Supabase SQL Editor of the environment:

- **Default for everyone without their own allowance** (sizes in bytes; 1 GiB = 1073741824):

  ```sql
  update private.storage_defaults set allowance_bytes = 2147483648, updated_at = now()
    where pool_kind = 'personal';
  update private.storage_defaults set allowance_bytes = 10737418240, updated_at = now()
    where pool_kind = 'home';
  ```

- **One person** (by email) or **one Home** (by id). NULL goes back to the default:

  ```sql
  select public.set_storage_allowance(
    (select id from auth.users where email = 'person@example.com'), null, 2147483648);
  select public.set_storage_allowance(null, '<home id>', 10737418240);
  ```

Lowering an allowance below what is stored never deletes anything: the pool shows as full, new uploads are refused, and the 80% and 95% notices go out once. Everything else keeps working.

- **Health at a glance**: `select * from public.storage_stats();` shows open object deletions, how old the oldest is, and uploads in progress (no names or keys).

## Switching storage on for a hosted environment

Storage is off on every hosted environment (`STORAGE_DRIVER=off`): pictures cannot be uploaded there, and the app says so. Turning it on needs a provider the owner has approved. **Cloudflare R2 most likely asks for a payment card when you activate it** (docs/provider-cost-register.md). Do not add a card unless you have decided to accept that.

If you approve R2, these are the steps, once per environment (preview, production):

1. Go to **https://dash.cloudflare.com** and sign in with the account that holds Turnstile.
2. In the left menu click **R2 Object Storage**. If it asks you to activate R2 or add a payment method, this is the card decision: continue only if you approved it.
3. Optional but recommended, once per account: in the left menu open **Notifications** (under **Manage account**), click **Add**, choose the **Usage Based Billing** alert for **R2**, and set a small threshold (for example storage above 8 GB), so you hear about usage long before the free tier ends.
4. Click **Create bucket**. Name: `madeora-preview` (or `madeora-production`). Location: **Automatic**. Storage class: **Standard**. Click **Create bucket**. Leave **Public access** off.
5. Open the bucket, go to **Settings**, find **CORS policy**, click **Add CORS policy** and paste (with the environment's own address):

   ```json
   [
     {
       "AllowedOrigins": ["https://madeora.studio"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 600
     }
   ]
   ```

   For the preview bucket, list the exact preview address you test with (R2 does not accept wildcards in the middle of an address), or keep storage off on previews.

6. Back in **R2 Object Storage**, click **Manage API tokens** (right side), then **Create API token**. Name: `madeora-production-app`. Permissions: **Object Read & Write**. Specify bucket: **Apply to specific buckets only**, select the bucket from step 4. TTL: **Forever**. Click **Create API Token**.
7. Copy the **Access Key ID**, the **Secret Access Key** and the **S3 endpoint** (`https://<account id>.r2.cloudflarestorage.com`) shown once on the result page.
8. In **Vercel** (https://vercel.com, project `madeora`, **Settings**, **Environment Variables**), add for the matching environment only:
   - `STORAGE_DRIVER` = `s3`
   - `STORAGE_S3_ENDPOINT` = the S3 endpoint from step 7
   - `STORAGE_S3_REGION` = `auto`
   - `STORAGE_S3_BUCKET` = the bucket name from step 4
   - `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY` = from step 7 (mark both **Sensitive**)
   - `SUPABASE_SERVICE_ROLE_KEY` = that environment's Supabase secret key (Supabase, **Project Settings**, **API Keys**, **Secret keys**; mark **Sensitive**)
9. In **Trigger.dev** (https://cloud.trigger.dev, project `madeora`, **Environment Variables**, the matching environment), add the same six `STORAGE_*` values, so the clean-up jobs can delete objects.
10. Redeploy (Vercel, **Deployments**, the latest one, **⋯**, **Redeploy**). Then open **Settings** in the app: the **Profile picture** card now offers **Choose a picture**. Upload one and check it shows in a Home's member list.

## Runbook

- **"Storage can't be reached"** for everyone: check the provider's status page and the Vercel logs for `storage.unavailable` with its short code (`network`, or `status_` plus the provider's HTTP status). `status_403` means the token was revoked or no longer covers the bucket. Uploads resume on their own; nothing is lost because unfinished uploads simply expire.
- **Uploads fail at the PUT step in the browser** (the picker says the upload took too long): the bucket's CORS policy does not list this exact address (step 5).
- **Objects left behind**: `open_deletions` in `select * from public.storage_stats();` should drift to 0 as the `storage-object-delete` job runs. If it does not, check the job's runs in Trigger.dev; a permanent failure there usually means storage is off for the jobs (step 9).
- **Someone sees a picture they should not**: views are re-authorized on every request, so removing the membership or the picture stops it at once; a link already opened works for up to 60 seconds.
- **Backups**: none during development. The development database is rebuilt from migrations and synthetic seeds, and uploaded pictures there are disposable. A production recovery strategy for files is a release requirement, not part of S15.
