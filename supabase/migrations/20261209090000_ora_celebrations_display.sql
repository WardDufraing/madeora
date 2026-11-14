-- S47c: Ora celebrations for chore points and the display-only Ora widget (brief S47c; spec
-- "Confirmed Ora subtle animated achievement celebrations", "Confirmed subtle Ora chore-point
-- celebration presentation", "Confirmed display-only Ora on wall displays").
--
--   public.ora_celebrations         one row per person and points-ledger entry already celebrated.
--                                   It is the de-duplication: the same award never cheers twice,
--                                   whatever the device, tab, refresh or retry. It belongs to the
--                                   membership and goes with it;
--   public.claim_ora_celebrations   security definer. Looks only at the caller's own chore awards in
--                                   one Home that were posted in the last 15 minutes and have not
--                                   been reversed, claims them, and answers one grouped line. It
--                                   claims nothing while Ora is off, Quiet is chosen or the
--                                   celebrations switch is off;
--   private.valid_display_layout    now also allows the settings-free "ora" widget.
-- Nobody, an Owner included, reads or writes another member's rows.

create table public.ora_celebrations (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  home_id uuid not null,
  -- The ledger entry (private.point_entries.id). Not a foreign key: the ledger is append-only and
  -- private, and a celebration must outlive nothing it depends on.
  entry_id uuid not null,
  celebrated_at timestamptz not null default now(),
  constraint ora_celebrations_pkey primary key (user_id, entry_id),
  constraint ora_celebrations_membership_fkey foreign key (home_id, user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

alter table public.ora_celebrations enable row level security;

comment on table public.ora_celebrations is
  'Ledger entries Ora has already celebrated with a person; prevents duplicate cheers (S47c).';

-- Rows are written only by public.claim_ora_celebrations. The person may read their own.
revoke all on table public.ora_celebrations from anon, authenticated;
grant select on table public.ora_celebrations to authenticated;

create policy ora_celebrations_select_own on public.ora_celebrations
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = ora_celebrations.home_id and m.user_id = (select auth.uid())
    )
  );

create index ora_celebrations_home_idx on public.ora_celebrations (home_id, user_id);

-- The 15-minute window of public.claim_ora_celebrations reads only recent chore awards, so a person's
-- whole history is not walked on every check.
create index point_entries_recent_awards_idx on private.point_entries (account_id, created_at desc)
  where kind = 'chore_award';

-- Claims the caller's new, unreversed chore awards in p_home_id and answers
-- {"count": n, "points": total, "title": name or null} (title only when exactly one), or null when
-- there is nothing to celebrate. An award counts for 15 minutes after it was posted; a later ask
-- finds it already claimed. Membership is checked first (42501 otherwise).
create function public.claim_ora_celebrations(p_home_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user uuid := auth.uid();
    v_prefs public.ora_preferences;
    v_result jsonb;
  begin
    if v_user is null then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if p_home_id is null or not private.is_home_member(p_home_id, v_user) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    select * into v_prefs from public.ora_preferences p where p.user_id = v_user;
    if found and (not v_prefs.enabled or not v_prefs.cat_celebrations or v_prefs.frequency = 'quiet') then
      return null;
    end if;
    with eligible as (
      select e.id, e.amount, e.occurrence_id
      from private.point_entries e
      join private.point_accounts a on a.id = e.account_id and a.home_id = e.home_id
      where a.user_id = v_user and e.home_id = p_home_id and e.kind = 'chore_award'
        and e.created_at > now() - interval '15 minutes'
        and not exists (select 1 from private.point_entries r where r.reverses_id = e.id)
      order by e.seq desc
      limit 20
    ), claimed as (
      insert into public.ora_celebrations (user_id, home_id, entry_id)
      select v_user, p_home_id, el.id from eligible el
      on conflict (user_id, entry_id) do nothing
      returning entry_id
    )
    select pg_catalog.jsonb_build_object(
             'count', count(*),
             'points', sum(el.amount),
             'title', case when count(*) = 1 then (
               select coalesce(o.closed_title, c.title)
               from eligible x
               join claimed cl2 on cl2.entry_id = x.id
               join private.chore_occurrences o on o.id = x.occurrence_id
               join private.chores c on c.id = o.chore_id
               limit 1) end)
      into v_result
      from eligible el join claimed cl on cl.entry_id = el.id
      having count(*) > 0;
    return v_result;
  end
  $$;

revoke all on function public.claim_ora_celebrations(uuid) from public, anon;
grant execute on function public.claim_ora_celebrations(uuid) to authenticated;

comment on function public.claim_ora_celebrations(uuid) is
  'S47c: claims the caller''s new unreversed chore awards in a Home and returns one grouped line, or null.';

-- The display-only Ora widget has no settings: its config must be empty. A layout that already
-- exists stays valid.
create or replace function private.valid_display_layout(p_layout jsonb) returns boolean
  language plpgsql immutable set search_path = '' as $$
  declare
    v_widget jsonb;
    v_ids text[] := '{}';
  begin
    if p_layout is null or pg_catalog.jsonb_typeof(p_layout) <> 'object'
       or p_layout -> 'version' is distinct from '1'::jsonb
       or pg_catalog.jsonb_typeof(p_layout -> 'widgets') is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_layout -> 'widgets') > 8
       or pg_catalog.octet_length(p_layout::text) > 8192
       or exists (select 1 from pg_catalog.jsonb_object_keys(p_layout) k
                  where k not in ('version', 'widgets')) then
      return false;
    end if;
    for v_widget in select w from pg_catalog.jsonb_array_elements(p_layout -> 'widgets') w loop
      if pg_catalog.jsonb_typeof(v_widget) <> 'object'
         or coalesce(v_widget ->> 'type', '') not in ('clock', 'chores', 'shopping', 'ora')
         or coalesce(v_widget ->> 'size', '') not in ('small', 'medium', 'large')
         or coalesce(v_widget ->> 'id', '')
              !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or pg_catalog.jsonb_typeof(v_widget -> 'config') is distinct from 'object'
         or (v_widget ->> 'type' = 'chores' and v_widget -> 'config' ? 'actions'
             and pg_catalog.jsonb_typeof(v_widget -> 'config' -> 'actions') <> 'boolean')
         or (v_widget ->> 'type' = 'ora' and v_widget -> 'config' <> '{}'::jsonb)
         or (v_widget ->> 'id') = any (v_ids) then
        return false;
      end if;
      v_ids := v_ids || (v_widget ->> 'id');
    end loop;
    return true;
  end
  $$;
