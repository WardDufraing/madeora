-- Review backlog Part 10: the last owner decisions (plans/steps/fix-review-backlog-brief.md,
-- "Decisions log", rows 26 and 28; the other rows are recorded in docs/adr/0058).
-- - Decision 26: a primary guardian who was deactivated (or pending deletion) when the Owner appointed a
--   new primary guardian becomes the child's secondary guardian when they return, if the secondary place
--   is free (no secondary, or the secondary was the one appointed primary). The new primary stays
--   primary. If another secondary guardian is in place, that guardian stays and the returning guardian
--   gets no role (a child has at most one secondary guardian).
-- - Decision 28 (S38-L8): a security report asked for in a time zone the database does not know falls
--   back to UTC instead of failing.
-- Both functions are replaced in place with the same signatures and grants. No table or column changes,
-- no data rewritten. Forward-only. Rollback: re-apply private.apply_child_guardian from
-- 20261213090000_review_decisions.sql and public.request_security_report from
-- 20261212090000_review_backlog_api_jobs_perf.sql.

-- Decision 26 ----------------------------------------------------------------------------------------------

-- As 20261213090000, except that a previous primary guardian who is no longer eligible is carried over as
-- secondary too, when no other secondary guardian keeps that place.
create or replace function private.apply_child_guardian(
  p_home_id uuid, p_child uuid, p_target uuid, p_role text, p_actor uuid
) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_primary uuid;
    v_secondary uuid;
  begin
    select g.guardian_user_id into v_primary from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = p_child and g.role = 'primary';
    select g.guardian_user_id into v_secondary from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = p_child and g.role = 'secondary';

    if p_role = 'secondary' then
      delete from public.child_guardians g
        where g.home_id = p_home_id and g.child_user_id = p_child and g.role = 'secondary';
      insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
        values (p_home_id, p_child, p_target, 'secondary', p_actor);
    else
      delete from public.child_guardians g
        where g.home_id = p_home_id and g.child_user_id = p_child;
      insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
        values (p_home_id, p_child, p_target, 'primary', p_actor);
      if v_secondary is not null and v_secondary <> p_target then
        insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
          values (p_home_id, p_child, v_secondary, 'secondary', p_actor);
      elsif v_primary is not null and v_primary <> p_target then
        -- Decision 26: also a previous primary who is deactivated or pending deletion. Their row holds
        -- no authority while they are ineligible (child_guardian_role), so they act as the secondary
        -- guardian only once they return.
        insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
          values (p_home_id, p_child, v_primary, 'secondary', p_actor);
      end if;
    end if;
    -- An open offer to the new guardian for the other role no longer makes sense.
    delete from public.child_guardian_offers o
      where o.home_id = p_home_id and o.child_user_id = p_child and o.guardian_user_id = p_target;
    perform private.audit('child.guardian_assigned', p_home_id, 'user', p_child,
      jsonb_build_object('role', p_role, 'guardian', p_target));
  end
  $$;

-- Decision 28 (S38-L8) ------------------------------------------------------------------------------------

-- As 20261212090000, except that an unknown time zone falls back to UTC (see the body).
create or replace function public.request_security_report(p_from date, p_to date, p_timezone text)
returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_today date;
    v_earliest date;
    v_id uuid;
    v_snapshot timestamptz;
    v_zone text;
    v_slack integer := 0;
    v_from date;
    v_to date;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    -- S38-L8 (owner decision 28): a zone the database does not know (the browser's ICU list and
    -- pg_timezone_names differ) falls back to UTC instead of failing. The report then says UTC. The
    -- dates were picked in the browser's zone, so they may be a day off in UTC: one day is tolerated
    -- at each end and the range is clamped to what UTC allows.
    if p_timezone is not null and pg_catalog.char_length(p_timezone) <= 64
       and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
      v_zone := p_timezone;
    else
      v_zone := 'UTC';
      v_slack := 1;
    end if;
    v_today := (pg_catalog.now() at time zone v_zone)::date;
    v_earliest := ((pg_catalog.now() - private.activity_retention()) at time zone v_zone)::date;
    if p_from is null or p_to is null or p_from > p_to
       or p_from < v_earliest - v_slack or p_to > v_today + v_slack then
      raise exception 'invalid range' using errcode = '22023';
    end if;
    v_from := greatest(p_from, v_earliest);
    v_to := least(p_to, v_today);
    if v_from > v_to then
      raise exception 'invalid range' using errcode = '22023';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.has_account_change_grant(v_user_id, 'security_report', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if (select pg_catalog.count(*) from private.security_reports r
        where r.user_id = v_user_id and r.created_at > pg_catalog.now() - interval '24 hours')
       >= private.security_report_daily_limit() then
      raise exception 'too many reports' using errcode = '54000', hint = 'rate_limited';
    end if;
    -- clock_timestamp: the snapshot is fixed before the request is recorded, so the report never
    -- contains its own request.
    v_snapshot := pg_catalog.clock_timestamp();
    insert into private.security_reports (user_id, range_from, range_to, timezone, snapshot_at, expires_at, rows)
      values (v_user_id, v_from, v_to, v_zone, v_snapshot,
              pg_catalog.now() + private.security_report_lifetime(),
              (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'kind', a.kind, 'outcome', a.outcome, 'home_name', a.home_name, 'actor', a.actor,
                  'device_kind', a.device_kind, 'browser', a.browser, 'platform', a.platform,
                  'created_at', a.created_at) order by a.created_at, a.id), '[]'::jsonb)
               from private.account_activity_events a
               where a.user_id = v_user_id and a.category = 'security'
                 and a.created_at >= (v_from::timestamp at time zone v_zone)
                 and a.created_at < ((v_to + 1)::timestamp at time zone v_zone)
                 and a.created_at < v_snapshot
                 and a.created_at > pg_catalog.now() - private.activity_retention()))
      returning id into v_id;
    insert into private.account_security_events (user_id, kind, session_id, created_at)
      values (v_user_id, 'security_report_requested', v_session_id, pg_catalog.clock_timestamp());
    perform private.notify_user(
      v_user_id, null, 'security', 'account.security_report_ready', '{}'::jsonb,
      'account.security_report_ready:' || v_id::text, true);
    return v_id;
  end
  $$;
