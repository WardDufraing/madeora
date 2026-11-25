-- UX8b: privacy-safe household information in the ambient view of Household Displays (redesign
-- decision 36: "time, date, weather and selected privacy-safe household information ... only
-- include household details approved for ambient visibility"; brief plans/steps/UX8b-brief.md).
--
-- - Two Home settings next to the UX8a ambient timing, both off by default: show the number of open
--   chores, and show the number of shopping items left. Counts only: the display already carries
--   these chores and lists on its board (display_board decides what is shared-display-safe), and
--   the ambient view never shows a title, a name, an assignee or a list's contents.
-- - The Home's managers (Owner, or Administrator with manageHomeSettings) change them through
--   save_home_display_ambient, which saves the timing and both choices at once, audited, and moves
--   only that Home's display signals.
-- - The UX8a two-argument save_home_display_settings is kept unchanged so a web app still on the
--   previous version keeps working while this rolls out; it never touches the new columns.
-- - display_session_state also returns the two choices (its return type changes, so it is dropped
--   and created again with the same grants: service_role only).
--
-- Rollback (app first, then this): drop public.save_home_display_ambient; recreate
-- public.display_session_state and public.home_display_settings from 20261222090000; drop the two
-- columns.

-- 1. The two choices ---------------------------------------------------------------------------------------------

alter table private.home_display_settings
  add column ambient_show_chores boolean not null default false,
  add column ambient_show_shopping boolean not null default false;

comment on table private.home_display_settings is
  'UX8a/UX8b: how long a Home''s displays wait without a touch before the ambient view, and which '
  'privacy-safe counts that view may show (both off by default).';

-- 2. Reading them (managers) -------------------------------------------------------------------------------------

create or replace function public.home_display_settings(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_row private.home_display_settings;
  begin
    if private.display_manager_check(p_home_id, v_user_id, false) <> 'ok' then
      raise exception 'not a manager of this Home' using errcode = '42501';
    end if;
    select * into v_row from private.home_display_settings s where s.home_id = p_home_id;
    return pg_catalog.jsonb_build_object(
      'ambient_after_seconds', private.home_ambient_after(p_home_id),
      'ambient_show_chores', coalesce(v_row.ambient_show_chores, false),
      'ambient_show_shopping', coalesce(v_row.ambient_show_shopping, false));
  end
  $$;

revoke all on function public.home_display_settings(uuid) from public, anon;
grant execute on function public.home_display_settings(uuid) to authenticated;

-- 3. Saving them (managers) --------------------------------------------------------------------------------------

-- Saves the Home's ambient timing and both choices at once. Outcomes: 'saved', 'unchanged',
-- 'not_permitted', 'not_found'.
create function public.save_home_display_ambient(
  p_home_id uuid,
  p_ambient_after_seconds integer,
  p_show_chores boolean,
  p_show_shopping boolean
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_check text;
    v_row private.home_display_settings;
  begin
    if p_ambient_after_seconds is null
       or p_ambient_after_seconds not in (60, 120, 300, 600, 900, 1800)
       or p_show_chores is null or p_show_shopping is null then
      raise exception 'invalid display settings' using errcode = '22023';
    end if;
    -- Locks the Home row, so two managers saving at once are serialized.
    v_check := private.display_manager_check(p_home_id, v_user_id, true);
    if v_check <> 'ok' then
      return v_check;
    end if;
    select * into v_row from private.home_display_settings s where s.home_id = p_home_id;
    if private.home_ambient_after(p_home_id) = p_ambient_after_seconds
       and coalesce(v_row.ambient_show_chores, false) = p_show_chores
       and coalesce(v_row.ambient_show_shopping, false) = p_show_shopping then
      return 'unchanged';
    end if;
    insert into private.home_display_settings as s
        (home_id, ambient_after_seconds, ambient_show_chores, ambient_show_shopping, updated_by)
      values (p_home_id, p_ambient_after_seconds, p_show_chores, p_show_shopping, v_user_id)
      on conflict (home_id) do update
        set ambient_after_seconds = excluded.ambient_after_seconds,
            ambient_show_chores = excluded.ambient_show_chores,
            ambient_show_shopping = excluded.ambient_show_shopping,
            updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    perform private.audit('display.settings_changed', p_home_id, 'home', p_home_id,
      pg_catalog.jsonb_build_object('ambient_after_seconds', p_ambient_after_seconds,
                                    'ambient_show_chores', p_show_chores,
                                    'ambient_show_shopping', p_show_shopping));
    return 'saved';
  end
  $$;

revoke all on function public.save_home_display_ambient(uuid, integer, boolean, boolean)
  from public, anon;
grant execute on function public.save_home_display_ambient(uuid, integer, boolean, boolean)
  to authenticated;

-- 4. The display's state (the web server only, as service_role) ------------------------------------------------

drop function public.display_session_state(uuid);

-- What the display's screen needs beyond its board: the Home's ambient timing and choices, and who
-- has a session on it now with how many seconds are left. No row for a display that is not active.
create function public.display_session_state(p_display_id uuid)
returns table (
  ambient_after_seconds integer,
  unlocked_membership_id uuid,
  unlock_seconds_left integer,
  ambient_show_chores boolean,
  ambient_show_shopping boolean
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays := private.active_display(p_display_id);
    v_member uuid;
    v_settings private.home_display_settings;
  begin
    if v_display.id is null then
      return;
    end if;
    delete from private.display_unlock_sessions s
      where s.display_id = v_display.id and s.expires_at <= pg_catalog.now();
    v_member := private.display_unlocked_member(v_display.id);
    select * into v_settings from private.home_display_settings s
      where s.home_id = v_display.home_id;
    return query
      select private.home_ambient_after(v_display.home_id),
             case when v_member is null then null
                  else private.member_ref(v_display.home_id, v_member) end,
             case when v_member is null then null
                  else (select greatest(1, ceil(extract(epoch from s.expires_at - pg_catalog.now()))::integer)
                        from private.display_unlock_sessions s where s.display_id = v_display.id) end,
             coalesce(v_settings.ambient_show_chores, false),
             coalesce(v_settings.ambient_show_shopping, false);
  end
  $$;

revoke all on function public.display_session_state(uuid) from public, anon, authenticated;
grant execute on function public.display_session_state(uuid) to service_role;
