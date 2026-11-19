-- Review backlog Part 9b: the findings of the independent review of Part 9 (PR #105,
-- reviews/steps/fix-review-low-db-followup-review.md).
-- - MEDIUM-2: a row that fails in the sign-in classification or the goal rollover batch is no longer
--   counted as done, and is no longer retried first on every run. Each failure is recorded on the row
--   (attempts and time), the row is retried after a growing pause (5 minutes, doubling, at most a day)
--   and sorts behind rows that never failed, and public.job_batch_failures lets the hourly job log the
--   rows that keep failing at error level.
-- - MEDIUM-1: update_habit_pause keeps its old 5-argument form for one release, so a web build from
--   before 20261216090000 still resumes and changes pauses. Drop it in a later migration once every
--   deployed web build passes the habit id.
-- - LOW-1, LOW-2, LOW-4, LOW-5: see each function.
-- Adds four columns (defaults, no rewrite of existing values) and three functions; every other
-- function is replaced in place with the same signature.
-- Forward-only. Rollback: re-apply the bodies of 20261216090000_review_low_db_followup.sql, drop the
-- three new functions and the four columns.

-- Failed batch rows -----------------------------------------------------------------------------------------

alter table private.account_security_events
  add column classify_attempts integer not null default 0
    constraint account_security_events_classify_attempts_check check (classify_attempts >= 0),
  add column classify_failed_at timestamptz;
alter table private.goal_series
  add column roll_attempts integer not null default 0
    constraint goal_series_roll_attempts_check check (roll_attempts >= 0),
  add column roll_failed_at timestamptz;

-- How long a batch row that failed p_attempts times waits before the next try: 5 minutes, doubling,
-- at most a day.
create function private.job_retry_after(p_attempts integer) returns interval
  language sql immutable set search_path = '' as $$
  select least(interval '5 minutes' * pg_catalog.power(2, greatest(coalesce(p_attempts, 1), 1) - 1)::integer,
               interval '1 day');
  $$;
revoke all on function private.job_retry_after(integer) from public, anon, authenticated;

-- The batch rows that failed and are still waiting to succeed, per job, for the hourly job to log at
-- error level (MEDIUM-2). Counts and times only: no ids, users or content.
create function public.job_batch_failures()
returns table (source text, failing integer, max_attempts integer, oldest_failed_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select 'sign_in_events', count(*)::integer, coalesce(max(e.classify_attempts), 0), min(e.classify_failed_at)
  from private.account_security_events e
  where e.kind = 'signed_in' and e.classified_at is null and e.classify_attempts > 0
  union all
  select 'goal_series', count(*)::integer, coalesce(max(s.roll_attempts), 0), min(s.roll_failed_at)
  from private.goal_series s
  where s.deleted_at is null and s.roll_attempts > 0;
  $$;
revoke all on function public.job_batch_failures() from public, anon, authenticated;
grant execute on function public.job_batch_failures() to service_role;

-- MEDIUM-2: as 20261216090000_review_low_db_followup.sql, except that a failed row is not counted, is
-- recorded on the row, and waits (private.job_retry_after) behind rows that never failed.
create or replace function public.process_sign_in_events(p_limit integer default 200)
returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_event record;
    v_count integer := 0;
    v_seen_any boolean;
    v_new_device boolean;
    v_prefs record;
    v_alert text;
    v_unfinished boolean;
    v_before integer;
  begin
    for v_event in
      select e.* from private.account_security_events e
      where e.kind = 'signed_in' and e.classified_at is null
        and e.created_at <= pg_catalog.now() - private.sign_in_settle_time()
        and not (
          e.second_step_needed and e.second_step_at is null
          and e.created_at > pg_catalog.now() - private.second_step_wait()
          and private.session_is_live(e.user_id, e.session_id)
        )
        -- A row that failed waits before its next try, and comes after rows that never failed.
        and (e.classify_failed_at is null
          or e.classify_failed_at <= pg_catalog.now() - private.job_retry_after(e.classify_attempts))
      order by e.classify_attempts, e.created_at
      limit greatest(1, least(coalesce(p_limit, 200), 1000))
      for update skip locked
    loop
      -- One row that fails is logged and left for the next run; the rest of the batch goes on (S38-L11).
      v_before := v_count;
      begin
        update private.account_security_events set classified_at = pg_catalog.now()
          where id = v_event.id;
        v_count := v_count + 1;

        if exists (
          select 1 from private.account_security_events r
          where r.user_id = v_event.user_id and r.kind = 'reauthenticated'
            and r.session_id = v_event.session_id
        ) then
          continue;
        end if;

        v_unfinished := v_event.second_step_needed and v_event.second_step_at is null
          and not exists (
            select 1 from private.account_security_events r
            where r.user_id = v_event.user_id and r.kind = 'recovery_code_used'
              and r.session_id = v_event.session_id
          );
        if v_unfinished then
          insert into private.account_activity_events
              (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
               source_event_id, alerted, created_at)
            values (v_event.user_id, 'security', 'sign_in_unfinished', 'blocked', 'self',
                    v_event.device_kind, v_event.browser, v_event.platform, v_event.session_id,
                    v_event.id, true, v_event.created_at)
            on conflict (source_event_id) do nothing;
          perform private.notify_user(
            v_event.user_id, null, 'security', 'account.unfinished_sign_in',
            private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
            'account.unfinished_sign_in:' || v_event.id::text, true);
          continue;
        end if;

        -- From the marker the purge never deletes, not from the visible history (S38 review M2).
        select exists (
          select 1 from private.account_sign_in_markers s where s.user_id = v_event.user_id
        ) into v_seen_any;
        select not exists (
          select 1 from private.account_activity_events a
          where a.user_id = v_event.user_id and a.kind = 'signed_in' and a.category = 'security'
            and a.created_at > pg_catalog.now() - private.activity_retention()
            and a.device_kind is not distinct from v_event.device_kind
            and a.browser is not distinct from v_event.browser
            and a.platform is not distinct from v_event.platform
        ) into v_new_device;

        select coalesce(p.new_device, true) as new_device, coalesce(p.every_sign_in, false) as every_sign_in
          into v_prefs
          from (select 1) one
          left join private.security_alert_preferences p on p.user_id = v_event.user_id;

        v_alert := null;
        if v_seen_any then
          if v_new_device and v_prefs.new_device then
            v_alert := 'account.new_device_sign_in';
          elsif v_prefs.every_sign_in then
            v_alert := 'account.signed_in';
          end if;
        end if;

        insert into private.account_activity_events
            (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
             source_event_id, alerted, created_at)
          values (v_event.user_id, 'security', 'signed_in', 'completed', 'self', v_event.device_kind,
                  v_event.browser, v_event.platform, v_event.session_id, v_event.id,
                  v_alert is not null, v_event.created_at)
          on conflict (source_event_id) do nothing;
        insert into private.account_sign_in_markers (user_id, first_signed_in_at)
          values (v_event.user_id, v_event.created_at)
          on conflict (user_id) do nothing;

        if v_alert = 'account.new_device_sign_in' then
          perform private.notify_user(
            v_event.user_id, null, 'security', 'account.new_device_sign_in',
            private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
            'account.new_device_sign_in:' || v_event.id::text, true);
        elsif v_alert = 'account.signed_in' then
          perform private.notify_user(
            v_event.user_id, null, 'security', 'account.signed_in',
            private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
            'account.signed_in:' || v_event.id::text, true);
        end if;
      exception when others then
        -- Not counted as classified; recorded on the row (outside the rolled-back sub-block) so it
        -- backs off and shows in public.job_batch_failures.
        v_count := v_before;
        update private.account_security_events
          set classify_attempts = classify_attempts + 1, classify_failed_at = pg_catalog.now()
          where id = v_event.id;
        raise warning 'process_sign_in_events: event % failed (%), attempt %', v_event.id, sqlstate,
          v_event.classify_attempts + 1;
      end;
    end loop;
    return v_count;
  end
  $$;

-- MEDIUM-2: as 20261216090000_review_low_db_followup.sql, except that a failure is recorded on the series,
-- which then waits (private.job_retry_after) behind series that never failed; a success clears it.
create or replace function public.roll_goal_periods(p_limit integer default null)
returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
    v_created integer := 0;
  begin
    for v_id in select s.id from private.goal_series s
        where s.next_roll_at <= pg_catalog.now() and s.deleted_at is null
          -- A series that failed waits before its next try, and comes after series that never failed.
          and (s.roll_failed_at is null
            or s.roll_failed_at <= pg_catalog.now() - private.job_retry_after(s.roll_attempts))
        order by s.roll_attempts, s.next_roll_at, s.id
        limit least(coalesce(p_limit, private.goal_limit('roll_batch')), private.goal_limit('roll_batch'))
        for update skip locked loop
      -- One series that fails is logged and skipped; the others still roll (S30b-L2). It stays due, so
      -- the next run (or a read of the series) tries it again.
      begin
        v_created := v_created + private.roll_goal_series(v_id, pg_catalog.now());
        update private.goal_series s set roll_attempts = 0, roll_failed_at = null
          where s.id = v_id and s.roll_attempts > 0;
      exception when others then
        -- Recorded on the series (outside the rolled-back sub-block) so it backs off and shows in
        -- public.job_batch_failures.
        update private.goal_series s
          set roll_attempts = s.roll_attempts + 1, roll_failed_at = pg_catalog.now()
          where s.id = v_id;
        raise warning 'roll_goal_periods: series % failed (%)', v_id, sqlstate;
      end;
    end loop;
    return v_created;
  end
  $$;

-- Habit pauses: the old form for one release (MEDIUM-1) ------------------------------------------------------

-- The 5-argument form of 20261110090000_habits.sql, kept so a web build from before 20261216090000 keeps
-- working while the release goes out: it reads the pause's own habit and calls the current form, which
-- then checks everything again. Remove it in a later migration.
create function public.update_habit_pause(
  p_pause_id uuid, p_expected_revision integer, p_action text,
  p_resumes_on date default null, p_dry_run boolean default false
)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_habit_id uuid;
  begin
    perform private.require_confirmed_caller();
    select hp.habit_id into v_habit_id from private.habit_pauses hp where hp.id = p_pause_id;
    if v_habit_id is null then
      return query select 'not_found'::text, null::jsonb, null::integer;
      return;
    end if;
    return query select u.outcome, u.impact, u.revision
      from public.update_habit_pause(v_habit_id, p_pause_id, p_expected_revision, p_action, p_resumes_on,
        p_dry_run) u;
  end
  $$;
revoke all on function public.update_habit_pause(uuid, integer, text, date, boolean) from public, anon;
grant execute on function public.update_habit_pause(uuid, integer, text, date, boolean)
  to authenticated, service_role;

-- Children, ownership ------------------------------------------------------------------------------------

-- LOW-1: as 20261216090000_review_low_db_followup.sql, except that a secondary guardian also cannot remove
-- or flip an existing "off" override.
create or replace function public.set_child_access(
  p_home_id uuid, p_child_membership_id uuid, p_preset text, p_overrides jsonb,
  p_confirm_expansion boolean, p_expected_updated_at timestamp with time zone
)
returns table (outcome text, before_capabilities text[], after_capabilities text[])
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_caller_role text;
    v_settings public.child_home_settings;
    v_before text[];
    v_after text[];
  begin
    if p_preset is null or p_preset not in ('young_child', 'child', 'teen') then
      raise exception 'invalid preset' using errcode = '22023';
    end if;
    if p_overrides is null or not private.valid_child_overrides(p_overrides) then
      raise exception 'invalid overrides' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    v_caller_role := private.child_guardian_role(p_home_id, v_child, v_user_id);
    if v_caller_role is null then
      return query select 'not_permitted'::text, null::text[], null::text[];
      return;
    end if;

    select * into v_settings from public.child_home_settings s
      where s.home_id = p_home_id and s.child_user_id = v_child for update;
    v_before := private.child_effective_capabilities(v_settings.preset, v_settings.overrides);
    v_after := private.child_effective_capabilities(p_preset, p_overrides);

    if p_expected_updated_at is null or v_settings.updated_at <> p_expected_updated_at then
      return query select 'stale'::text, v_before, v_after;
      return;
    end if;
    -- A secondary guardian only switches things off: no new "on" override either, even one that
    -- changes nothing today but would keep a capability on after a later preset change (S41-L1).
    if v_caller_role = 'secondary'
       and (p_preset <> v_settings.preset or not (v_before @> v_after)
         or exists (select 1 from pg_catalog.jsonb_each(p_overrides) o
           where o.value = 'true'::jsonb and v_settings.overrides -> o.key is distinct from 'true'::jsonb)
         -- Nor remove an "off" override, which would let a later preset turn it on (review LOW-1).
         or exists (select 1 from pg_catalog.jsonb_each(v_settings.overrides) o
           where o.value = 'false'::jsonb and p_overrides -> o.key is distinct from 'false'::jsonb)) then
      return query select 'not_permitted'::text, v_before, v_after;
      return;
    end if;
    if p_preset = v_settings.preset and p_overrides = v_settings.overrides then
      return query select 'unchanged'::text, v_before, v_after;
      return;
    end if;
    if not (v_before @> v_after) and not coalesce(p_confirm_expansion, false) then
      return query select 'confirmation_required'::text, v_before, v_after;
      return;
    end if;

    update public.child_home_settings s
      set preset = p_preset, overrides = p_overrides, updated_by = v_user_id,
          updated_at = pg_catalog.clock_timestamp()
      where s.home_id = p_home_id and s.child_user_id = v_child;
    perform private.audit('child.access_changed', p_home_id, 'user', v_child,
      jsonb_build_object(
        'preset_before', v_settings.preset, 'preset_after', p_preset,
        'before', to_jsonb(v_before), 'after', to_jsonb(v_after)
      ));
    return query select 'saved'::text, v_before, v_after;
  end
  $$;

-- LOW-2: as 20261216090000_review_low_db_followup.sql, except that a replayed request whose pending transfer
-- is past its expiry (not yet swept) answers 'expired', not 'started'.
create or replace function public.start_ownership_transfer(
  p_home_id uuid, p_membership_id uuid, p_request_id uuid
)
returns table (outcome text, transfer_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
    v_existing private.home_ownership_transfers;
    v_id uuid;
  begin
    if p_request_id is null then
      raise exception 'a request id is required' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) <> 'owner' then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;

    select * into v_existing from private.home_ownership_transfers t
      where t.from_user_id = v_user_id and t.creation_request_id = p_request_id;
    if found then
      -- A replay answers 'started' only while that transfer is still pending (S12-L3).
      if v_existing.home_id <> p_home_id then
        return query select 'not_found'::text, null::uuid;
      elsif v_existing.status = 'pending' and v_existing.expires_at > pg_catalog.now() then
        return query select 'started'::text, v_existing.id;
      elsif v_existing.status in ('expired', 'pending') then
        return query select 'expired'::text, null::uuid;
      elsif v_existing.status = 'invalid' then
        return query select 'no_longer_valid'::text, null::uuid;
      else
        return query select 'already_decided'::text, null::uuid;
      end if;
      return;
    end if;

    select * into v_target from public.home_memberships m
      where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if v_target.user_id = v_user_id or v_target.role = 'owner'
       or private.confirmed_email(v_target.user_id) is null
       or private.is_deactivated(v_target.user_id) then
      return query select 'invalid_target'::text, null::uuid;
      return;
    end if;

    perform private.expire_ownership_transfers(p_home_id);
    if exists (
      select 1 from private.home_ownership_transfers t
      where t.home_id = p_home_id and t.status = 'pending'
    ) then
      return query select 'pending_exists'::text, null::uuid;
      return;
    end if;

    insert into private.home_ownership_transfers (
      home_id, from_user_id, to_user_id, expires_at, creation_request_id
    )
      values (
        p_home_id, v_user_id, v_target.user_id, pg_catalog.now() + interval '7 days', p_request_id
      )
      returning id into v_id;
    perform private.audit('home_ownership.transfer_started', p_home_id, 'ownership_transfer', v_id,
      pg_catalog.jsonb_build_object('to', v_target.user_id));
    return query select 'started'::text, v_id;
  end
  $$;

-- Notes that keep copies in step (LOW-4, LOW-5) -------------------------------------------------------------

comment on function private.absence_undecided_count(private.chore_absences) is
  'Counts the undecided, unprotected rows of private.absence_review_items (same reasons, order and limit; '
  'protected and decision as in private.chore_review_entry). Change these functions together.';
comment on function private.absence_review_items(private.chore_absences, uuid) is
  'The review list of an absence. private.absence_undecided_count repeats its rows to count them: '
  'change both together.';
comment on function private.shopping_today(uuid, text) is
  'The Home''s today, else today in p_time_zone, else UTC. p_time_zone must already be a name from '
  'pg_timezone_names (rules and requests are checked when written); this function does not check it.';
