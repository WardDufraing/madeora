# Database migrations on the hosted Supabase projects: owner guide

The app's tables are defined by the files in `supabase/migrations/`. Locally and in CI they are applied automatically. The two hosted projects, `madeora-preview` and `madeora-production`, get them from you, by pasting each file into Supabase's SQL Editor. No database password or secret key goes into GitHub or Vercel, and it costs nothing. Background: [ADR 0009](adr/0009-personal-preferences.md).

## When

- **`madeora-preview`:** when a pull request that adds a migration is ready for you to test on its preview: its checks are green and Claude has said the migration is final (the independent review has passed). Not earlier, because a file that changes after you applied it leaves the preview database different from Git. Migrations only add things, so previews of other branches keep working.
- **`madeora-production`:** just before you merge a release pull request (`production` ← `main`) whose commit list contains a migration. Apply it first, then merge: the code already in production ignores new tables, and the new code needs them.
- Apply every file you have not applied yet, **oldest first** (the file names start with the date). Never apply a file twice. The table below says how to check whether a file is already in.

| File                                                      | Step | Already applied when the check query says              |
| --------------------------------------------------------- | ---- | ------------------------------------------------------ |
| `supabase/migrations/20261013000000_private_schema.sql`   | S03  | `private_schema` is `true`                             |
| `supabase/migrations/20261014120000_user_preferences.sql` | S07  | `preferences_table` is `user_preferences` (not `NULL`) |
| `supabase/migrations/20261015090000_sign_in_methods.sql`  | S08  | `sign_in_methods_table` is not `NULL`                  |

Check query (read-only, safe to run any time):

```sql
select
  exists (select 1 from pg_namespace where nspname = 'private') as private_schema,
  to_regclass('public.user_preferences') as preferences_table,
  to_regclass('private.sign_in_method_grants') as sign_in_methods_table;
```

## Apply a migration

Do this for `madeora-preview` first; for production, the same steps in `madeora-production`.

1. Open https://supabase.com/dashboard/projects and click the project (`madeora-preview` or `madeora-production`). If it says **Paused**, click **Restore project** and wait until it is active.
2. In the left sidebar click **SQL Editor** (the `>_` icon).
3. Click **+** (or **New query**) at the top of the query list, then **Create a new snippet** if asked. An empty editor opens.
4. Paste the check query above and click **Run** (bottom right, or `Ctrl`+`Enter`). Note which files are already applied (see the table).
5. For the oldest file that is not applied yet:
   1. In a new browser tab, open the file on GitHub, for example https://github.com/WardDufraing/madeora/blob/main/supabase/migrations/20261014120000_user_preferences.sql. For a pull request that is not merged yet, use the pull request's branch instead of `main` in the address (for S07: `feat/personal-preferences`).
   2. Above the file's text, click the **Copy raw file** button (two overlapping squares).
   3. Back in Supabase, select everything in the editor (`Ctrl`+`A`, on a Mac `Cmd`+`A`), press `Delete`, paste (`Ctrl`+`V` / `Cmd`+`V`) and click **Run**.
   4. If Supabase warns that the query contains destructive or row-level-security operations, read the name in the warning; if it is the file you meant to run, click **Run this query**.
   5. The result panel must say **Success. No rows returned**. If it shows an error, stop: do not run anything else, and send Claude the error text.
6. Repeat step 5 for the next file, until every file is applied.
7. Run the check query again: every column now shows the "applied" value from the table.

## Check S07 (`20261014120000_user_preferences.sql`)

1. In the SQL Editor, run:

   ```sql
   select
     c.relrowsecurity as rls_on,
     (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'user_preferences') as policies,
     has_table_privilege('anon', 'public.user_preferences', 'select') as visitors_can_read,
     has_table_privilege('authenticated', 'public.user_preferences', 'delete') as members_can_delete,
     has_column_privilege('authenticated', 'public.user_preferences', 'updated_at', 'update')
       as members_can_set_updated_at
   from pg_class c
   where c.oid = 'public.user_preferences'::regclass;
   ```

   It must show `rls_on` **true**, `policies` **3**, and **false** for `visitors_can_read`, `members_can_delete` and `members_can_set_updated_at`.

2. In the app (the preview, or `https://www.madeora.studio` after the release), sign in, open **Settings**, type a display name and click **Save** under it. "Display name saved." appears. Reload the page: the name is still there, and the dashboard says "Welcome, _your name_".

## Check S08 (`20261015090000_sign_in_methods.sql`)

1. In the SQL Editor, run:

   ```sql
   select
     (select count(*) from pg_trigger
       where tgrelid = 'auth.identities'::regclass
         and tgname in ('madeora_guard_identity_insert', 'madeora_guard_identity_delete',
                        'madeora_check_identity_link_flow')
         and tgenabled = 'O') as identity_guards,
     has_function_privilege('anon', 'public.authorize_sign_in_method_change(text, text)', 'execute')
       as visitors_can_ask,
     has_function_privilege('authenticated', 'public.authorize_sign_in_method_change(text, text)', 'execute')
       as members_can_ask,
     has_table_privilege('authenticated', 'private.sign_in_method_grants', 'select')
       as members_can_read_grants;
   ```

   It must show `identity_guards` **3**, `visitors_can_ask` **false**, `members_can_ask` **true** and `members_can_read_grants` **false**. If `identity_guards` is not 3, do not switch Google on in that project; tell Claude.

2. Then continue with [`docs/google-sign-in-setup.md`](google-sign-in-setup.md).

## If a migration file changed after you applied it

This can happen on `madeora-preview` when a pull request is changed after you tested it. Claude says so in the pull request. Preview data is synthetic, so the fix is to undo the file and apply it again:

1. Run the file's undo block from this guide (for S07: the block below) in the SQL Editor of `madeora-preview`.
2. Apply the file again as in "Apply a migration", from the pull request's branch.
3. Run the file's check again.

Never do this on `madeora-production`: production only gets files from `main`, after review, so they do not change afterwards. If a merged migration needs a correction, it comes as a new file.

## If you need to undo S07

Only if the S07 pull request is abandoned, or Claude asks for it. This deletes every saved preference in that project.

```sql
drop table if exists public.user_preferences;
drop function if exists private.set_updated_at();
```

The app keeps working without the table: everyone gets the default preferences, and saving shows an error.

## If you need to undo S08

Only if the S08 pull request is abandoned, or Claude asks for it, and **only after** switching Google off in that project (`docs/google-sign-in-setup.md`, "If you need to switch Google sign-in off"). Without these rules Supabase would attach Google to any account with the same email address.

```sql
drop trigger if exists madeora_guard_identity_insert on auth.identities;
drop trigger if exists madeora_guard_identity_delete on auth.identities;
drop trigger if exists madeora_check_identity_link_flow on auth.identities;
drop function if exists public.authorize_sign_in_method_change(text, text);
drop function if exists private.guard_identity_insert();
drop function if exists private.guard_identity_delete();
drop function if exists private.check_identity_link_flow();
drop function if exists private.consume_sign_in_method_grant(uuid, text, text);
drop function if exists private.has_usable_password(uuid);
drop function if exists private.lock_sign_in_methods(uuid);
drop function if exists private.sign_in_method_grant_lifetime();
drop function if exists private.sign_in_method_reauth_window();
drop table if exists private.sign_in_method_grants;
```

## What not to do

- Do not edit a migration in the SQL Editor before running it, and do not run SQL from anywhere else than a file in `supabase/migrations/` (or this guide).
- Do not copy the database password, the `service_role` key or a Secret key anywhere.
- Do not create tables or policies by clicking in the **Table Editor**: anything not in a migration file is lost when the database is rebuilt, and the local and CI databases would differ from the hosted ones.
