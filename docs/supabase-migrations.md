# Database migrations on the hosted Supabase projects: owner guide

The app's tables are defined by the files in `supabase/migrations/`. Locally and in CI they are applied automatically. The two hosted projects, `madeora-preview` and `madeora-production`, get them from you, by pasting each file into Supabase's SQL Editor. No database password or secret key goes into GitHub or Vercel, and it costs nothing. Background: [ADR 0009](adr/0009-personal-preferences.md).

## When

- **`madeora-preview`:** when a pull request that adds a migration is ready for you to test on its preview: its checks are green and Claude has said the migration is final (the independent review has passed). Not earlier, because a file that changes after you applied it leaves the preview database different from Git. Migrations only add things, so previews of other branches keep working.
- **`madeora-production`:** just before you merge a release pull request (`production` ← `main`) whose commit list contains a migration. Apply it first, then merge: the code already in production ignores new tables, and the new code needs them.
- Apply every file you have not applied yet, **oldest first** (the file names start with the date). Never apply a file twice. The table below says how to check whether a file is already in.

| File                                                                       | Step | Already applied when the check query says              |
| -------------------------------------------------------------------------- | ---- | ------------------------------------------------------ |
| `supabase/migrations/20261013000000_private_schema.sql`                    | S03  | `private_schema` is `true`                             |
| `supabase/migrations/20261014120000_user_preferences.sql`                  | S07  | `preferences_table` is `user_preferences` (not `NULL`) |
| `supabase/migrations/20261015090000_sign_in_methods.sql`                   | S08  | `sign_in_methods_table` is not `NULL`                  |
| `supabase/migrations/20261016090000_homes.sql`                             | S09  | `homes_table` is `homes` (not `NULL`)                  |
| `supabase/migrations/20261017090000_home_invitations.sql`                  | S10  | `invitations_table` is not `NULL`                      |
| `supabase/migrations/20261018090000_member_profiles.sql`                   | S11  | `member_profiles_table` is not `NULL`                  |
| `supabase/migrations/20261019090000_roles_and_ownership.sql`               | S12  | `ownership_transfers_table` is not `NULL`              |
| `supabase/migrations/20261020090000_ownership_recovery.sql`                | S12b | `ownership_recoveries_table` is not `NULL`             |
| `supabase/migrations/20261026090000_tasks.sql`                             | S18  | `tasks_table` is not `NULL`                            |
| `supabase/migrations/20261027090000_task_recurrence.sql`                   | S19  | `task_series_table` is not `NULL`                      |
| `supabase/migrations/20261028090000_task_reminders_templates_bulk.sql`     | S19b | `task_templates_table` is not `NULL`                   |
| `supabase/migrations/20261029090000_task_attachments_calendar_widgets.sql` | S19c | `task_attachments_table` is not `NULL`                 |
| `supabase/migrations/20261030090000_chores.sql`                            | S20  | `chores_table` is not `NULL`                           |
| `supabase/migrations/20261031090000_chore_templates_history_bulk.sql`      | S20  | `chore_templates_table` is not `NULL`                  |
| `supabase/migrations/20261101090000_chore_pool_claims.sql`                 | S21  | `chore_requests_table` is not `NULL`                   |
| `supabase/migrations/20261102090000_chore_proposals_volunteers.sql`        | S21  | `chore_proposals_table` is not `NULL`                  |
| `supabase/migrations/20261103090000_chore_overview_reminders.sql`          | S21  | `chore_reminders_table` is not `NULL`                  |
| `supabase/migrations/20261104090000_home_vacations.sql`                    | S22  | `home_vacations_table` is not `NULL`                   |
| `supabase/migrations/20261105090000_points_rewards.sql`                    | S23  | `point_accounts_table` is not `NULL`                   |

Check query (read-only, safe to run any time):

```sql
select
  exists (select 1 from pg_namespace where nspname = 'private') as private_schema,
  to_regclass('public.user_preferences') as preferences_table,
  to_regclass('private.sign_in_method_grants') as sign_in_methods_table,
  to_regclass('public.homes') as homes_table,
  to_regclass('private.home_invitations') as invitations_table,
  to_regclass('public.home_member_profiles') as member_profiles_table,
  to_regclass('private.home_ownership_transfers') as ownership_transfers_table,
  to_regclass('private.home_ownership_recoveries') as ownership_recoveries_table,
  to_regclass('private.tasks') as tasks_table,
  to_regclass('private.task_series') as task_series_table,
  to_regclass('private.task_templates') as task_templates_table,
  to_regclass('private.task_attachments') as task_attachments_table,
  to_regclass('private.chores') as chores_table,
  to_regclass('private.chore_templates') as chore_templates_table,
  to_regclass('private.chore_reassignment_requests') as chore_requests_table,
  to_regclass('private.chore_proposals') as chore_proposals_table,
  to_regclass('private.chore_reminders') as chore_reminders_table,
  to_regclass('private.home_vacations') as home_vacations_table,
  to_regclass('private.point_accounts') as point_accounts_table;
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

## Check S11 (`20261018090000_member_profiles.sql`)

This file also makes the display-name rule stricter. Before applying it, you can see whether it will clear anyone's display name (names with invisible or text-direction characters; the person can type their name again afterwards). This query only reads:

```sql
select count(*) as names_to_clear
from public.user_preferences
where display_name ~ '[\u0001-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0]';
```

It counts names with the usual invisible characters (the full rule also catches a few rarer cases, such as a joiner at the start). It usually shows `0`. After applying:

1. In the SQL Editor, run:

   ```sql
   select
     c.relrowsecurity as rls_on,
     (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'home_member_profiles') as policies,
     has_table_privilege('anon', 'public.home_member_profiles', 'select') as visitors_can_read,
     has_table_privilege('authenticated', 'public.home_member_profiles', 'delete') as members_can_delete,
     has_function_privilege('anon', 'public.home_directory(uuid)', 'execute') as visitors_can_list,
     has_function_privilege('authenticated', 'public.home_directory(uuid)', 'execute') as members_can_list,
     has_column_privilege('authenticated', 'public.user_preferences', 'accent_color', 'update')
       as accent_saveable
   from pg_class c
   where c.oid = 'public.home_member_profiles'::regclass;
   ```

   It must show `rls_on` **true**, `policies` **3**, `visitors_can_read` **false**, `members_can_delete` **false**, `visitors_can_list` **false**, `members_can_list` **true** and `accent_saveable` **true**.

2. In the app, open a Home, click **Members**: you are listed with "(you)". Click **How you appear here**, type a nickname and click **Save**: "Nickname saved." appears, and the Members page shows the nickname.

## Check S12 (`20261019090000_roles_and_ownership.sql`)

From S12 an Administrator manages Member invitations and join requests only when the Owner has given them the right "Manage invitations" (before S12 only the Owner could). Nothing else changes for existing Homes: everyone keeps their role, and Administrators start without extra rights.

1. In the SQL Editor, run:

   ```sql
   select
     (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'homes' and policyname = 'homes_update_manager')
       as settings_policy,
     (select count(*) from pg_trigger
       where tgrelid = 'public.home_memberships'::regclass
         and tgname in ('home_memberships_drop_capabilities', 'home_memberships_invalidate_transfers',
                        'home_memberships_forget_departed')) as membership_triggers,
     has_table_privilege('authenticated', 'private.home_admin_capabilities', 'select')
       as members_can_read_rights,
     has_table_privilege('authenticated', 'private.home_ownership_transfers', 'select')
       as members_can_read_transfers,
     has_function_privilege('anon', 'public.remove_home_member(uuid, uuid, text)', 'execute')
       as visitors_can_remove,
     has_function_privilege('authenticated', 'public.remove_home_member(uuid, uuid, text)', 'execute')
       as members_can_ask_removal,
     (select count(*) from public.home_memberships where role = 'owner')
       = (select count(*) from public.homes) as one_owner_per_home;
   ```

   It must show `settings_policy` **1**, `membership_triggers` **3**, **false** for `members_can_read_rights`, `members_can_read_transfers` and `visitors_can_remove`, and **true** for `members_can_ask_removal` and `one_owner_per_home`.

2. In the app you need two accounts in one Home (the second one joined through an invitation, S10). As the Owner, open the Home, click **Members**, then **Manage** next to the other person:
   1. Under **Role** choose **Administrator**, click **Change role** and confirm. "_Name_ is now Administrator." appears.
   2. Under **Administrator rights** tick **Remove members**, click **Save rights** and confirm. "_Name_'s rights are saved." appears.
   3. Sign in as the other person (another browser, or a private window), open the Home, click **Members**, then **How you appear here**: the **Your role and rights** card lists "Remove members".
   4. Back as the Owner, on the same Manage page, untick the right and save again, so the preview is back as it was.

## Check S12b (`20261020090000_ownership_recovery.sql`)

From S12b a member who cannot reach their Home's Owner can ask Madeora to review an ownership recovery, and Madeora staff review it on the staff pages. Nothing changes for existing Homes. Apply it only after the staff-operations change (ADR 0015) is merged.

1. In the SQL Editor, run:

   ```sql
   select
     (select count(*) from pg_trigger
       where tgrelid = 'public.home_memberships'::regclass
         and tgname = 'home_memberships_invalidate_recoveries') as recovery_trigger,
     has_table_privilege('authenticated', 'private.home_ownership_recoveries', 'select')
       as members_can_read_cases,
     has_table_privilege('authenticated', 'private.madeora_staff', 'select')
       as members_can_read_staff,
     has_function_privilege('anon', 'public.staff_ownership_recoveries()', 'execute')
       as visitors_can_list_cases,
     has_function_privilege('authenticated', 'public.request_ownership_recovery(uuid, text, uuid)', 'execute')
       as members_can_ask,
     (select count(*) from public.home_memberships where role = 'owner')
       = (select count(*) from public.homes) as one_owner_per_home;
   ```

   It must show `recovery_trigger` **1**, **false** for `members_can_read_cases`, `members_can_read_staff` and `visitors_can_list_cases`, and **true** for `members_can_ask` and `one_owner_per_home`.

2. Add yourself as staff in this project (`docs/staff-operations.md`, "Add a staff member"), then in the app open **Settings**: a **Madeora staff** card with **Ownership recovery requests** appears. Click it: the list opens (empty, or with requests made on this project).

## Check S15 (`20261023090000_file_storage.sql`)

From S15 people can upload a profile picture, and each person and each Home has a storage allowance (1 GiB and 5 GiB, development placeholders; `docs/file-storage.md`). Nothing changes for existing data: nobody has a picture yet, and pools are created when first used. Uploads stay off until `STORAGE_DRIVER=s3` is set for that environment.

1. In the SQL Editor, run:

   ```sql
   select
     (select count(*) from private.storage_defaults) as defaults_rows,
     has_table_privilege('authenticated', 'private.stored_files', 'select') as members_can_read_files,
     has_function_privilege('authenticated', 'public.finalize_upload(uuid, uuid, text, bigint, text)', 'execute')
       as members_can_finalize,
     has_function_privilege('authenticated', 'public.create_upload_intent(text, text, bigint, uuid)', 'execute')
       as members_can_start_upload,
     has_function_privilege('service_role', 'public.finalize_upload(uuid, uuid, text, bigint, text)', 'execute')
       as server_can_finalize;
   ```

   It must show `defaults_rows` **2**, **false** for `members_can_read_files` and `members_can_finalize`, and **true** for `members_can_start_upload` and `server_can_finalize`.

2. In the app open **Settings**: a **Profile picture** card and a **Storage** card appear. Without storage configured, the picture card says uploads aren't set up here yet; **View your storage** shows 0 of 1 GB used.

## Check S16 (`20261024090000_trash_and_recovery.sql`)

From S16 there is a trash for each person and each Home: deleted items stay recoverable for 7 days (the **Trash** link in Settings and in a Home's settings). No module deletes anything into it yet (tasks arrive in S18), so nothing changes for existing data and the trash is empty. Apply it only after S15 (`20261023090000_file_storage.sql`) is applied.

1. In the SQL Editor, run:

   ```sql
   select
     has_table_privilege('authenticated', 'private.trash_entries', 'select') as members_can_read_entries,
     has_function_privilege('authenticated', 'public.restore_trash_entries(uuid[], jsonb)', 'execute')
       as members_can_restore,
     has_function_privilege('authenticated', 'public.purge_expired_trash_entry(uuid)', 'execute')
       as members_can_run_the_job,
     has_function_privilege('service_role', 'public.purge_expired_trash_entry(uuid)', 'execute')
       as server_can_run_the_job,
     (select count(*) from private.trash_entries) as entries;
   ```

   It must show **false** for `members_can_read_entries` and `members_can_run_the_job`, **true** for `members_can_restore` and `server_can_run_the_job`, and `entries` **0**.

2. In the app open **Settings** and click **Open your trash**: "The trash is empty" appears. Open a Home, click **Settings**, then **Open this Home's trash**: the same.

## Check S18 (`20261026090000_tasks.sql`)

From S18 there are tasks in the Personal space and in every Home (the **Tasks** item in the sidebar). Nothing changes for existing data: there are no lists or tasks until someone creates them. Apply it only after S16 (`20261024090000_trash_and_recovery.sql`) and S17 (`20261025090000_dashboards.sql`) are applied, because it extends their trash functions and the Administrator capabilities.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.tasks') as tasks_table,
     has_table_privilege('authenticated', 'private.tasks', 'select') as members_can_read_tasks,
     has_function_privilege('authenticated', 'public.set_task_completion(uuid, boolean)', 'execute')
       as members_can_complete,
     has_function_privilege('anon', 'public.list_tasks(uuid, uuid, date, text, text, boolean, text[], uuid[], text, uuid, text, integer, integer)', 'execute')
       as signed_out_can_list,
     private.is_delegable_capability('manageHomeTasks') as new_capability,
     (select count(*) from private.tasks) as tasks;
   ```

   It must show `tasks_table` **private.tasks**, **false** for `members_can_read_tasks` and `signed_out_can_list`, **true** for `members_can_complete` and `new_capability`, and `tasks` **0**.

2. In the app click **Tasks** in the sidebar: "No task lists yet" appears. Click **Lists and labels**, create a list, go back and add a task. Open a Home and click **Tasks**: the Home's own, empty, task page appears.

## Check S19 (`20261027090000_task_recurrence.sql`)

From S19 a task can repeat. Nothing changes for existing tasks: none of them repeats until someone creates a repeating task. Apply it only after S18 (`20261026090000_tasks.sql`), because it extends its functions.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.task_series') as task_series_table,
     has_table_privilege('authenticated', 'private.task_series', 'select') as members_can_read_series,
     has_function_privilege('authenticated', 'public.advance_task_series(uuid, date)', 'execute')
       as members_can_advance,
     has_function_privilege('anon', 'public.list_task_occurrences(uuid, text, integer, integer, date, text)', 'execute')
       as signed_out_can_read_history,
     (select count(*) from private.task_series) as series;
   ```

   It must show `task_series_table` **private.task_series**, **false** for `members_can_read_series` and `signed_out_can_read_history`, **true** for `members_can_advance`, and `series` **0**.

2. In the app click **Tasks**, then **New task**: the form has a **Repeats** field. Add a task with a due date of today that repeats weekly: its row says "Repeats", and its page shows the Repeats section with the next date.

## Check S19b (`20261028090000_task_reminders_templates_bulk.sql`)

From S19b a task can have a reminder, tasks can be made from templates, and several tasks can be changed at once. Nothing changes for existing tasks. Apply it only after S19 (`20261027090000_task_recurrence.sql`), because it extends its functions. Deploy the Trigger.dev tasks from the same commit with it (`docs/trigger-setup.md`, step 4): reminders are delivered by the job `task-reminder`.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.task_templates') as task_templates_table,
     has_table_privilege('authenticated', 'private.task_reminders', 'select') as members_can_read_reminders,
     has_function_privilege('authenticated', 'public.deliver_task_reminder(uuid, integer)', 'execute')
       as members_can_deliver,
     has_function_privilege('authenticated', 'public.bulk_update_tasks(uuid[], text, jsonb, boolean, uuid, text, text, uuid[], uuid)', 'execute')
       as members_can_bulk,
     (select count(*) from private.task_reminders) as reminders;
   ```

   It must show `task_templates_table` **private.task_templates**, **false** for `members_can_read_reminders` and `members_can_deliver`, **true** for `members_can_bulk`, and `reminders` **0**.

2. In the app open a task with a due date: its page has a **Reminder** section. Click **Set a reminder**: the form shows "It will remind around …". Under **Notifications** in Settings, a **Task reminders** group appears.

## Check S19c (`20261029090000_task_attachments_calendar_widgets.sql`)

From S19c files can be attached to tasks, tasks have a calendar view, and dashboards can show a tasks widget. Nothing changes for existing tasks or saved dashboards. Apply it only after S19b (`20261028090000_task_reminders_templates_bulk.sql`), because it extends its functions. Attachments need file storage switched on (`docs/file-storage.md`); without it the task page says uploads are not available.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.task_attachments') as task_attachments_table,
     has_table_privilege('authenticated', 'private.task_attachments', 'select') as members_can_read_attachments,
     has_function_privilege('authenticated', 'public.attach_task_file(uuid, text)', 'execute')
       as members_can_attach,
     private.task_limit('attachments') as attachment_limit,
     (select count(*) from private.task_attachments) as attachments;
   ```

   It must show `task_attachments_table` **private.task_attachments**, **false** for `members_can_read_attachments`, **true** for `members_can_attach`, `attachment_limit` **10** and `attachments` **0**.

2. In the app open **Tasks**: a **List / Calendar** switch is above the tasks, and **Calendar** shows the month. Open a task: its page has an **Attachments** section. On the dashboard, **Customize** offers **Personal tasks**.

## Check S20 (`20261030090000_chores.sql`, `20261031090000_chore_templates_history_bulk.sql`)

From S20 every Home has **Chores**: one-off and repeating chores with rotation, checklists, optional approval, templates, a searchable history, bulk changes and three dashboard widgets. Nothing changes for existing data. Apply the two files in this order, after S19c (`20261029090000_task_attachments_calendar_widgets.sql`), because they reuse its task schedule functions.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.chores') as chores_table,
     to_regclass('private.chore_templates') as chore_templates_table,
     has_table_privilege('authenticated', 'private.chores', 'select') as members_can_read_chores,
     has_table_privilege('authenticated', 'private.chore_submissions', 'select')
       as members_can_read_submissions,
     has_function_privilege('authenticated',
       'public.review_chore_submission(uuid, integer, text, text)', 'execute') as members_can_review_call,
     has_function_privilege('authenticated',
       'public.bulk_chore_occurrences(uuid, text, jsonb, boolean, uuid, date, text)', 'execute')
       as members_can_bulk_call,
     (select count(*) from private.chores) as chores;
   ```

   It must show both tables (**private.chores**, **private.chore_templates**), **false** for `members_can_read_chores` and `members_can_read_submissions`, **true** for both `_call` columns (the functions check each person's rights themselves) and `chores` **0**.

2. In the app open a Home: the sidebar's **Chores** opens its chores, with **History** and, for the Owner, **Manage chores and categories** (with **Templates**). On the Home dashboard, **Customize** offers **My Chores**, **All Home Chores** and **Pending Approvals**. Under **Notifications** in Settings, a **Chore approvals** group appears.

## Check S21 (`20261101090000_chore_pool_claims.sql`)

From S21 unassigned chores wait in a **pool** where members claim them, with Undo, release, an optional close at the end of the week and automatic release, and members can ask someone else to take over an occurrence. Existing chores get the defaults (all members may claim, unclaimed chores stay available as overdue, no automatic release). Apply it after the two S20 files.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.chore_reassignment_requests') as requests_table,
     to_regclass('public.chore_pool_signals') as signals_table,
     has_table_privilege('authenticated', 'private.chore_reassignment_requests', 'select')
       as members_can_read_requests,
     has_function_privilege('authenticated', 'public.claim_chore_occurrence(uuid)', 'execute')
       as members_can_claim_call,
     exists (select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and tablename = 'chore_pool_signals') as realtime_on,
     (select count(*) from private.chores where claim_mode <> 'all') as changed_chores;
   ```

   It must show both tables, **false** for `members_can_read_requests`, **true** for `members_can_claim_call` and `realtime_on`, and `changed_chores` **0**. If `realtime_on` is **false**, the pool still works but updates only after a reload; run `alter publication supabase_realtime add table public.chore_pool_signals;`.

2. In the app add a chore without assignees: it shows under **Unassigned chores** on the Home's Chores page with **Claim**. In a second browser signed in as another member, the claimed chore disappears without reloading. **Manage chores and categories** has **Chore settings** (week start, confirmation of handovers); an occurrence page has **Claim** with the chore's claim rules.

## Check S21b (`20261102090000_chore_proposals_volunteers.sql`)

From here every member can propose a chore for a chore manager to approve, and a chore that needs reassignment can be offered to selected members, the first to volunteer getting it. Nothing changes for existing chores. Apply it after `20261101090000_chore_pool_claims.sql`.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.chore_proposals') as proposals_table,
     to_regclass('private.chore_volunteer_requests') as volunteer_table,
     has_table_privilege('authenticated', 'private.chore_proposals', 'select')
       as members_can_read_proposals,
     has_function_privilege('authenticated', 'public.list_chore_proposals(uuid)', 'execute')
       as members_can_list_call;
   ```

   It must show both tables, **false** for `members_can_read_proposals` and **true** for `members_can_list_call`.

2. In the app the Home's Chores page has **Suggest a chore** (for chore managers **Proposals**). An occurrence that needs reassignment has **Ask for a volunteer** for chore managers.

## Check S21c (`20261103090000_chore_overview_reminders.sql`)

From here the Chores page has a **Calendar** where chore managers move one occurrence, assignees can set a personal reminder on an occurrence, chore managers can turn on a daily summary, and dashboards can show a **Chore schedule** widget. Nothing changes for existing chores. Apply it after the S21b file, and deploy the Trigger.dev tasks from the same commit (`docs/trigger-setup.md`, step 4): reminders are delivered by `chore-reminder` and the summary is sent by the hourly schedule `chore-digest`.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.chore_reminders') as reminders_table,
     to_regclass('private.chore_summary_settings') as summary_table,
     has_table_privilege('authenticated', 'private.chore_reminders', 'select')
       as members_can_read_reminders,
     has_function_privilege('authenticated', 'public.list_chore_schedule(uuid, date, date)', 'execute')
       as members_can_read_schedule_call,
     has_function_privilege('authenticated', 'public.send_chore_summaries(integer)', 'execute')
       as members_can_send_summaries;
   ```

   It must show both tables, **false** for `members_can_read_reminders` and `members_can_send_summaries` (only the jobs worker sends), and **true** for `members_can_read_schedule_call`.

2. In the app the Chores page has **Calendar** and, for chore managers, **Daily summary**. An occurrence assigned to you has **Your reminder**. On a Home dashboard, **Customize** offers **Chore schedule**.

## Check S22 (`20261104090000_home_vacations.sql`)

From here a Home has **Vacations** (with invitations, a Home-wide chore pause and a review of affected chores) and the Chores page has **Absences**. Existing chores do not change until someone records a vacation. Apply it after the S21c file, and deploy the Trigger.dev tasks from the same commit (`docs/trigger-setup.md`, step 4): the optional pre-vacation reminder is delivered by `vacation-reminder`.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.home_vacations') as vacations_table,
     to_regclass('private.chore_absences') as absences_table,
     has_table_privilege('authenticated', 'private.home_vacations', 'select')
       as members_can_read_vacations,
     has_function_privilege('authenticated', 'public.list_home_vacations(uuid)', 'execute')
       as members_can_list_call,
     has_function_privilege('authenticated', 'public.deliver_vacation_reminder(uuid, date, integer)', 'execute')
       as members_can_deliver_reminders;
   ```

   It must show both tables, **false** for `members_can_read_vacations` and `members_can_deliver_reminders` (only the jobs worker delivers), and **true** for `members_can_list_call`.

2. In the app the Home page and the Chores page have **Vacations**, and the Chores page has **Absences**. On a Home dashboard, **Customize** offers **Home vacation**.

## Check S23 (`20261105090000_points_rewards.sql`)

From here chores can carry **points**, members earn them by completing chores, and a Home has **Points**, **Rewards** and an optional **Leaderboard**. Existing chores and templates get 0 points (late policy "full"), so nobody earns anything until a chore manager sets points. Apply it after the S22 file. No new background job: points and rewards notifications are written by the database functions.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.point_accounts') as accounts_table,
     to_regclass('private.point_entries') as entries_table,
     to_regclass('private.rewards') as rewards_table,
     to_regclass('private.reward_redemptions') as redemptions_table,
     has_table_privilege('authenticated', 'private.point_entries', 'select')
       as members_can_read_ledger,
     has_function_privilege('authenticated', 'public.get_point_summary(uuid)', 'execute')
       as members_can_read_own_summary,
     has_function_privilege('anon', 'public.list_point_accounts(uuid)', 'execute')
       as anonymous_can_list_accounts;
   ```

   It must show the four tables, **false** for `members_can_read_ledger` and `anonymous_can_list_accounts`, and **true** for `members_can_read_own_summary`.

2. In the app the Chores page links to **Points** and **Rewards**, and the chore form has **Points**. An Administrator's capabilities (Home members, Manage) include **Manage Home rewards**, **Approve reward requests** and **Manage member points**. On a Home dashboard, **Customize** offers **Weekly points**, **Leaderboard** and **My points**.

## Check S24 (`20261106090000_recipes.sql`)

From here everyone has **Recipes**: a Personal recipe library, one per Home, private drafts, an exclusive editing lock, ratings, favorites, cooking mode with serving scaling, a cover photo and a **Recipes** dashboard widget. Nothing changes for existing data. Apply it after the S23 file. No new background job: unsaved cover uploads are retired by the existing upload expiry job.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.recipes') as recipes_table,
     to_regclass('private.recipe_edit_locks') as locks_table,
     to_regclass('private.recipe_ratings') as ratings_table,
     has_table_privilege('authenticated', 'private.recipes', 'select')
       as members_can_read_recipes_table,
     has_function_privilege('authenticated', 'public.list_recipes(uuid, text, text[], boolean, text, integer, integer)', 'execute')
       as members_can_list_recipes,
     has_function_privilege('anon', 'public.get_recipe(uuid)', 'execute')
       as anonymous_can_read_recipe;
   ```

   It must show the three tables, **false** for `members_can_read_recipes_table` and `anonymous_can_read_recipe`, and **true** for `members_can_list_recipes`.

2. In the app the sidebar's **Meals** opens **Recipes**, with **New recipe** and **My drafts**. An Administrator's capabilities (Home members, Manage) include **Manage Home recipes**. On a dashboard, **Customize** offers **Recipes**.

## Check S25 (`20261107090000_recipe_sharing_import.sql`)

From here a recipe can be **shared with another Home** (one recipe, never a copy), deleting a shared recipe first shows **what it affects**, and recipes can be **imported from a website**. Nothing changes for existing data. Apply it after the S24 file. No new background job and no new provider: the import fetches the page from the app server.

1. In the SQL Editor, run:

   ```sql
   select
     to_regclass('private.recipe_shares') as shares_table,
     to_regclass('private.recipe_import_attempts') as import_attempts_table,
     has_table_privilege('authenticated', 'private.recipe_shares', 'select')
       as members_can_read_shares_table,
     has_function_privilege('authenticated', 'public.share_recipe(uuid, uuid, boolean)', 'execute')
       as members_can_share,
     has_function_privilege('anon', 'public.begin_recipe_import()', 'execute')
       as anonymous_can_import;
   ```

   It must show both tables, **false** for `members_can_read_shares_table` and `anonymous_can_import`, and **true** for `members_can_share`.

2. In the app a published recipe shows **Share with a Home** to its recipe managers, and the recipe library shows **Import from a website**.

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

## If you need to undo S11

Only if the S11 pull request is abandoned, or Claude asks for it. This deletes every nickname, Home display name and accent colour in that project. The stricter name rule stays (the older app accepts it, and names it cleared are not restored). Applying the S11 file again afterwards works.

```sql
drop function if exists public.home_directory(uuid);
drop table if exists public.home_member_profiles;
drop function if exists private.keep_home_member_profile_owner();
alter table public.user_preferences drop column if exists accent_color;
```

## If you need to undo S12

Only if the S12 pull request is abandoned, or Claude asks for it. This deletes every Administrator right and every ownership transfer request in that project; roles and memberships stay as they are, and ownership that already moved stays moved. Two small things stay (the older app ignores them): the history log keeps the reason a membership ended, and accepts the ownership-transfer entries it already has. Applying the S12 file again afterwards works.

```sql
drop function if exists public.respond_to_ownership_transfer(uuid, uuid, text);
drop function if exists public.cancel_ownership_transfer(uuid, uuid);
drop function if exists public.start_ownership_transfer(uuid, uuid, uuid);
drop function if exists public.leave_home(uuid);
drop function if exists public.remove_home_member(uuid, uuid, text);
drop function if exists public.set_administrator_capabilities(uuid, uuid, text[]);
drop function if exists public.change_home_member_role(uuid, uuid, text, text);
drop function if exists public.home_ownership_transfer(uuid);
drop function if exists public.home_capabilities(uuid);
drop trigger if exists home_memberships_invalidate_transfers on public.home_memberships;
drop trigger if exists home_memberships_forget_departed on public.home_memberships;
drop trigger if exists home_memberships_drop_capabilities on public.home_memberships;
drop function if exists private.invalidate_ownership_transfers();
drop function if exists private.forget_departed_member();
drop function if exists private.drop_capabilities_on_role_change();
drop function if exists private.expire_ownership_transfers(uuid);
drop function if exists private.transfer_state(private.home_ownership_transfers);
drop function if exists private.home_role(uuid, uuid);
drop table if exists private.home_ownership_transfers;
drop policy if exists homes_update_manager on public.homes;
create policy homes_update_owner on public.homes
  for update
  to authenticated
  using (
    exists (
      select 1 from public.home_memberships m
      where m.home_id = homes.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    )
  )
  with check (
    exists (
      select 1 from public.home_memberships m
      where m.home_id = homes.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    )
  );
create or replace function private.can_manage_invitations(p_home_id uuid, p_user_id uuid, p_role text)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and p_role in ('member', 'administrator') and exists (
    select 1 from public.home_memberships m
    where m.home_id = p_home_id and m.user_id = p_user_id and m.role = 'owner'
  );
  $$;
create or replace function public.decide_join_request(p_home_id uuid, p_request_id uuid, p_decision text)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_request private.home_join_requests;
    v_inv private.home_invitations;
  begin
    if p_decision is null or p_decision not in ('approve', 'decline') then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      return 'not_found';
    end if;
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      return 'not_permitted';
    end if;

    -- Lock order everywhere: request, then invitation.
    select * into v_request from private.home_join_requests r
      where r.id = p_request_id and r.home_id = p_home_id for update;
    if not found then
      return 'not_found';
    end if;
    if not private.can_manage_invitations(p_home_id, v_user_id, v_request.role) then
      return 'not_permitted';
    end if;
    if v_request.status <> 'pending' then
      return 'already_decided';
    end if;
    select * into v_inv from private.home_invitations i where i.id = v_request.invitation_id
      for update;

    if p_decision = 'decline' then
      update private.home_join_requests
        set status = 'declined', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      -- An email invitation has one possible recipient: once they are declined it is finished.
      if v_inv.kind = 'email' and v_inv.end_reason is null then
        update private.home_invitations
          set ended_at = pg_catalog.now(), ended_by = v_user_id, end_reason = 'declined'
          where id = v_inv.id;
      end if;
      perform private.audit('join_request.declined', p_home_id, 'join_request', p_request_id,
        pg_catalog.jsonb_build_object('role', v_request.role));
      return 'declined';
    end if;

    if exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_request.applicant_id
    ) then
      update private.home_join_requests
        set status = 'expired', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      perform private.audit('join_request.expired', p_home_id, 'join_request', p_request_id,
        pg_catalog.jsonb_build_object('reason', 'already_member'));
      return 'already_member';
    end if;

    if private.invitation_state(v_inv) <> 'active'
       or v_request.role <> v_inv.role
       or private.confirmed_email(v_request.applicant_id) is null
       or (v_inv.kind = 'email'
           and v_inv.recipient_email is distinct from private.confirmed_email(v_request.applicant_id))
    then
      update private.home_join_requests
        set status = 'expired', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      perform private.audit('join_request.expired', p_home_id, 'join_request', p_request_id);
      return 'no_longer_valid';
    end if;

    -- The S09 trigger audits the new membership with the approver as the actor.
    insert into public.home_memberships (home_id, user_id, role)
      values (p_home_id, v_request.applicant_id, v_request.role);
    update private.home_invitations set admissions = admissions + 1 where id = v_inv.id;
    update private.home_join_requests
      set status = 'approved', decided_at = pg_catalog.now(), decided_by = v_user_id
      where id = p_request_id;
    perform private.audit('join_request.approved', p_home_id, 'join_request', p_request_id,
      pg_catalog.jsonb_build_object('role', v_request.role, 'kind', v_inv.kind));
    return 'approved';
  end
  $$;
create or replace function public.list_home_invitations(p_home_id uuid)
returns table (
  id uuid, kind text, role text, recipient_email text, email_locale text, state text,
  created_at timestamptz, expires_at timestamptz, ended_at timestamptz,
  max_admissions integer, admissions integer, pending_requests integer,
  delivery_status text, last_sent_at timestamptz, token text
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select i.id, i.kind, i.role, i.recipient_email, i.email_locale, s.state,
        i.created_at, i.expires_at, i.ended_at, i.max_admissions, i.admissions,
        (select pg_catalog.count(*)::integer from private.home_join_requests r
          where r.invitation_id = i.id and r.status = 'pending'),
        i.delivery_status, i.last_sent_at,
        case when s.state = 'active' and i.kind <> 'email' then i.token end
      from private.home_invitations i
      cross join lateral (select private.invitation_state(i) as state) s
      where i.home_id = p_home_id
        and (s.state = 'active' or coalesce(i.ended_at, i.expires_at) > pg_catalog.now() - interval '30 days'
             or i.created_at > pg_catalog.now() - interval '30 days')
      order by (s.state = 'active') desc, i.created_at desc
      limit 200;
  end
  $$;
create or replace function public.list_home_join_requests(p_home_id uuid)
returns table (
  id uuid, applicant_name text, applicant_email text, role text, kind text, state text,
  created_at timestamptz, decided_at timestamptz, can_decide boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select r.id, r.applicant_name, r.applicant_email, r.role, i.kind, s.state,
        r.created_at, r.decided_at,
        s.state = 'pending' and private.can_manage_invitations(p_home_id, v_user_id, r.role)
      from private.home_join_requests r
      join private.home_invitations i on i.id = r.invitation_id
      cross join lateral (select private.request_state(r) as state) s
      where r.home_id = p_home_id
        and (r.status = 'pending' or r.decided_at > pg_catalog.now() - interval '30 days')
      order by (s.state = 'pending') desc, r.created_at desc
      limit 200;
  end
  $$;
drop function if exists private.lock_home(uuid);
drop function if exists private.caller_has_home_capability(uuid, text);
drop function if exists private.has_home_capability(uuid, uuid, text);
drop table if exists private.home_admin_capabilities;
drop function if exists private.check_capability_holder();
drop function if exists private.is_delegable_capability(text);
```

## If you need to undo S12b

Only if the S12b pull request is abandoned, or Claude asks for it. This deletes every ownership recovery request, objection and appeal, the staff list, and their entries in the history log, in that project. Ownership that already moved through a completed recovery stays moved. Applying the S12b file again afterwards works.

```sql
drop function if exists public.staff_close_recovery_appeal(uuid, text);
drop function if exists public.staff_decide_ownership_recovery(uuid, text, text, text);
drop function if exists public.staff_ownership_recovery(uuid);
drop function if exists public.staff_ownership_recoveries();
drop function if exists public.appeal_ownership_recovery(uuid, text);
drop function if exists public.my_recovered_homes();
drop function if exists public.accept_ownership_recovery(uuid, uuid);
drop function if exists public.object_to_ownership_recovery(uuid, text);
drop function if exists public.cancel_ownership_recoveries(uuid);
drop function if exists public.withdraw_ownership_recovery(uuid, uuid);
drop function if exists public.request_ownership_recovery(uuid, text, uuid);
drop function if exists public.home_ownership_recovery_status(uuid);
drop function if exists public.is_madeora_staff();
drop trigger if exists home_memberships_invalidate_recoveries on public.home_memberships;
drop function if exists private.invalidate_ownership_recoveries();
drop function if exists private.can_request_recovery(uuid, uuid);
drop function if exists private.settle_owner_returned(uuid);
drop function if exists private.recovery_state(private.home_ownership_recoveries);
drop function if exists private.staff_is_involved(uuid, uuid, uuid, uuid);
drop function if exists private.require_staff(boolean);
drop table if exists private.home_ownership_recovery_appeals;
drop table if exists private.home_ownership_recovery_objections;
drop table if exists private.home_ownership_recoveries;
drop table if exists private.madeora_staff;
delete from private.audit_events where subject_type = 'ownership_recovery';
alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in ('home', 'user', 'invitation', 'join_request', 'ownership_transfer'));
```

## What not to do

- Do not edit a migration in the SQL Editor before running it, and do not run SQL from anywhere else than a file in `supabase/migrations/` (or this guide).
- Do not copy the database password, the `service_role` key or a Secret key anywhere.
- Do not create tables or policies by clicking in the **Table Editor**: anything not in a migration file is lost when the database is rebuilt, and the local and CI databases would differ from the hosted ones.

## Order for the S14 release (notifications, ADR 0018)

The S14 migration moves invitation emails from the web request to a database trigger plus a Trigger.dev job. To avoid a double or a lost invitation email, apply in this order per environment: (1) deploy the Trigger.dev tasks with the email variables (`docs/trigger-setup.md`, steps 3 and 4); (2) apply the migration and release the web build together, with no invitations sent between the two. Applying the migration before the new web build is live makes the old build send the email as well as the job (two emails, different idempotency keys); releasing the web build first leaves new invitations on "Sending" with no job.
