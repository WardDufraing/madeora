-- Database-wide guards that every migration must keep true. They run against the fully migrated
-- and seeded database, so a later step that forgets RLS on a new table, or leaves a SECURITY DEFINER
-- function executable by anon or PUBLIC, fails here.

-- Supabase grants every API role access to new tables in schema public by default, so a table
-- without row level security would be readable and writable by anyone with the public API key.
select tests.assert_true(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ),
  'Every table in schema public has row level security enabled'
);

-- A view runs with its owner's rights unless it is security_invoker, which would bypass RLS.
select tests.assert_true(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and not coalesce(c.reloptions @> array['security_invoker=true'], false)
  ),
  'Every view in schema public is security_invoker (materialized views are not allowed there)'
);

-- Internal helpers live in schema private, which the API roles cannot use.
select tests.assert_true(
  not has_schema_privilege('anon', 'private', 'usage')
    and not has_schema_privilege('authenticated', 'private', 'usage'),
  'The API roles anon and authenticated cannot use schema private'
);

-- No function in schema private is executable by PUBLIC or the API roles unless it is allowlisted
-- here. When an RLS policy needs a helper, grant it in its migration and add its signature, as
-- regprocedure text such as 'private.is_home_member(uuid)', to this list with a comment saying why.
select tests.assert_true(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.oid::regprocedure::text <> all (array[
        -- S11: the pure visible-name rule that check constraints on names call; it reads nothing.
        'private.is_visible_name(text,integer)',
        -- S12: the homes update policy asks whether the caller (auth.uid(), never another
        -- account) holds a capability in a Home; it reveals nothing about anyone else.
        'private.caller_has_home_capability(uuid,text)',
        -- S37: the Realtime signal tables' policies ask whether the caller's own session is still
        -- signed in (and past two-factor); PostgREST's pre-request check asks the same and raises.
        -- Both read only the caller's own token and session.
        'private.request_session_ok()',
        'private.enforce_request_session()',
        -- S37: the signed-out account recovery steps (lost password and mailbox). Their public
        -- wrappers run with the visitor's rights; these check the emailed link's secret and the
        -- recovery code themselves and reveal nothing about whether an account exists.
        'private.start_account_recovery(text)',
        'private.continue_account_recovery(text,text,boolean)',
        'private.finish_account_recovery(text)',
        -- S40: the membership view (security_invoker, so it runs as its reader) leaves out Homes
        -- pending deletion; it only says whether a Home id is closed.
        'private.home_is_open(uuid)',
        -- S41: the child settings policy asks whether the caller guards that child in that Home;
        -- it only answers about the caller.
        'private.caller_child_guardian_role(uuid,uuid)'
      ]::text[])
      and (
        has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
        )
      )
  ),
  'No function in schema private is executable by PUBLIC, anon or authenticated unless allowlisted'
);

-- A SECURITY DEFINER function in schema public runs as its owner, so it bypasses row level security
-- on tables that owner can read. Supabase's default privileges grant every new function in schema
-- public to anon. Nothing created there may keep that grant, and PUBLIC must not have EXECUTE
-- either (the private-schema migration already takes it off the postgres role's default).
select tests.assert_true(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and (
        has_function_privilege('anon', p.oid, 'execute')
        or exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
        )
      )
  ),
  'No SECURITY DEFINER function in schema public is executable by anon or PUBLIC'
);

-- Jobs and operator runbooks. Each signature is granted to service_role only; a signed-in user must
-- not be able to execute any of them. When a migration adds one, add its signature here as
-- regprocedure text, such as 'public.claim_job_outbox(integer,integer)'. A signature that does not
-- resolve fails this test; it is not skipped. The list is every such function in the migrations.
select tests.assert_true(
  not exists (
    select 1
    from unnest(array[
      -- S13: the dispatcher and execution functions.
      'public.claim_job_outbox(integer,integer)',
      'public.complete_job_outbox(uuid,text)',
      'public.fail_job_outbox(uuid,text,boolean)',
      'public.release_job_outbox(uuid[])',
      'public.requeue_job_outbox(uuid)',
      'public.begin_job_execution(text,text,integer)',
      'public.finish_job_execution(text,text,uuid,text,text)',
      'public.job_outbox_stats()',
      -- S14: recovery-ready notice, and the invitation and notification email jobs.
      'public.deliver_recovery_ready(uuid,timestamptz)',
      'public.get_invitation_email(uuid,integer)',
      'public.record_invitation_email(uuid,integer,text)',
      'public.get_notification_email(uuid)',
      'public.record_notification_email(uuid,text,text)',
      -- S15: trusted upload facts, allowances and the storage jobs.
      'public.finalize_upload(uuid,uuid,text,bigint,text)',
      'public.set_storage_allowance(uuid,uuid,bigint)',
      'public.expire_upload(uuid)',
      'public.purge_stored_file(uuid)',
      'public.get_storage_object_deletion(uuid)',
      'public.complete_storage_object_deletion(uuid)',
      'public.storage_stats()',
      -- S16: the trash purge job and its runbook.
      'public.purge_expired_trash_entry(uuid)',
      'public.trash_stats()',
      -- S19b: task reminder jobs.
      'public.deliver_task_reminder(uuid,integer)',
      'public.advance_reminder_series(integer)',
      -- S21: an overdue claim the release job gives back.
      'public.release_overdue_chore_claim(uuid,integer)',
      -- S21c: chore reminder delivery and the manager summary.
      'public.deliver_chore_reminder(uuid,uuid,integer)',
      'public.send_chore_summaries(integer)',
      -- S22: the vacation reminder.
      'public.deliver_vacation_reminder(uuid,date,integer)',
      -- S28: habit reminder jobs.
      'public.deliver_habit_reminder(uuid,integer,timestamptz)',
      'public.advance_habit_reminders(integer)',
      'public.deliver_habit_snooze(uuid)',
      'public.deliver_habit_pause_end(uuid,date)',
      -- S30: the goal reminder.
      'public.deliver_goal_reminder(uuid,integer,text,timestamptz)',
      -- S30b: period rollover.
      'public.roll_goal_periods(integer)',
      -- S37: security emails to the backup address and the end of a recovery's wait.
      'public.get_security_email(uuid)',
      'public.record_security_email(uuid,text)',
      'public.deliver_account_recovery_ready(uuid,timestamptz)',
      -- S42: child sign-in steps (the web server checks the PIN or password hash) and the PIN
      -- screen of an approved household device.
      'public.child_password_attempt(text,text)',
      'public.child_pin_attempt(text,uuid,text)',
      'public.child_sign_in_verified(uuid)',
      'public.child_sign_in_complete(uuid,uuid)',
      'public.household_device_sign_in(text)',
      -- S42 part 2: chores completed on an approved household device.
      'public.shared_device_board(text)',
      'public.shared_device_attempt(text,uuid,uuid,boolean,text)',
      'public.shared_device_verified(text,uuid)',
      'public.shared_device_undo(text,uuid)'
    ]::regprocedure[]) as s(signature)
    where has_function_privilege('authenticated', s.signature, 'execute')
  ),
  'Signed-in users cannot execute service-role-only functions'
);

-- The synthetic seed is loaded, with its fixed IDs.
select tests.assert_true(
  tests.user_id('alice') = '10000000-0000-4000-8000-000000000001'
    and tests.user_id('bob') = '10000000-0000-4000-8000-000000000002',
  'The seeded synthetic users alice and bob exist with their fixed IDs'
);
