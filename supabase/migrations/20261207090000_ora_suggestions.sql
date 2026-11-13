-- S47: Ora suggestions, teasers and their suppression (brief S47; spec "Confirmed Ora smart
-- suppression of dismissed suggestions"; Ora design handoff: at most one unsolicited teaser per
-- person per day across all Homes and devices, and a personal mute that lasts until re-enabled).
--
--   public.ora_preferences.teasers_muted   the person's own mute, across every Home;
--   public.ora_preferences.last_teaser_on  the local date a teaser was last shown. It is written only
--                                          by public.claim_ora_teaser, never directly, so two devices
--                                          cannot both claim the same day;
--   public.ora_dismissed_suggestions       one row per person, place and suggestion kind: the
--                                          situation (a record or day) that was dismissed. The same
--                                          suggestion stays quiet until the situation changes.
-- A dismissal belongs to the membership and goes with it (leaving, removal, Home deletion).
-- Nobody, an Owner included, reads or sets another member's rows.

alter table public.ora_preferences
  add column teasers_muted boolean not null default false,
  add column last_teaser_on date;

grant insert (teasers_muted) on table public.ora_preferences to authenticated;
grant update (teasers_muted) on table public.ora_preferences to authenticated;

create table public.ora_dismissed_suggestions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- 'personal' or the Home's id as text; kept beside home_id so one key covers both places.
  scope text not null
    constraint ora_dismissed_scope_check check (scope = 'personal' or scope ~ '^[0-9a-f-]{36}$'),
  home_id uuid,
  kind text not null
    constraint ora_dismissed_kind_check check (kind in ('today-overview')),
  -- What was dismissed (for an overview: the day). A different situation may be offered again.
  situation text not null
    constraint ora_dismissed_situation_check check (char_length(situation) between 1 and 64),
  dismissed_at timestamptz not null default now(),
  constraint ora_dismissed_suggestions_pkey primary key (user_id, scope, kind),
  constraint ora_dismissed_home_check check (
    (scope = 'personal' and home_id is null) or (scope <> 'personal' and home_id::text = scope)
  ),
  constraint ora_dismissed_membership_fkey foreign key (home_id, user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

alter table public.ora_dismissed_suggestions enable row level security;

comment on table public.ora_dismissed_suggestions is
  'The Ora suggestion a person dismissed in one place, and the situation it was dismissed for (S47).';

revoke all on table public.ora_dismissed_suggestions from anon, authenticated;
grant select on table public.ora_dismissed_suggestions to authenticated;
grant insert (user_id, scope, home_id, kind, situation)
  on table public.ora_dismissed_suggestions to authenticated;
grant update (user_id, scope, home_id, kind, situation)
  on table public.ora_dismissed_suggestions to authenticated;

create policy ora_dismissed_select_own on public.ora_dismissed_suggestions
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_dismissed_suggestions.home_id and m.user_id = (select auth.uid())
      )
    )
  );

create policy ora_dismissed_insert_own on public.ora_dismissed_suggestions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_dismissed_suggestions.home_id and m.user_id = (select auth.uid())
      )
    )
  );

create policy ora_dismissed_update_own on public.ora_dismissed_suggestions
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_dismissed_suggestions.home_id and m.user_id = (select auth.uid())
      )
    )
  )
  with check (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_dismissed_suggestions.home_id and m.user_id = (select auth.uid())
      )
    )
  );

-- Claims today's teaser for the caller: true exactly once per person per local date, whichever Home
-- or device asks first, and never while teasers are muted. `p_today` is the person's local date as
-- the server worked it out; a date far from the real one is refused, so a forged date cannot buy
-- extra teasers.
create function public.claim_ora_teaser(p_today date) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user uuid := auth.uid();
    v_claimed boolean;
  begin
    if v_user is null or p_today is null then
      return false;
    end if;
    if abs(p_today - (now() at time zone 'utc')::date) > 1 then
      return false;
    end if;
    insert into public.ora_preferences as p (user_id, last_teaser_on)
      values (v_user, p_today)
      on conflict (user_id) do update set last_teaser_on = excluded.last_teaser_on
      where not p.teasers_muted and p.enabled
        and (p.last_teaser_on is null or p.last_teaser_on < excluded.last_teaser_on)
      returning true into v_claimed;
    return coalesce(v_claimed, false);
  end
  $$;

revoke all on function public.claim_ora_teaser(date) from public, anon;
grant execute on function public.claim_ora_teaser(date) to authenticated;

comment on function public.claim_ora_teaser(date) is
  'S47: true once per person per local date (not while muted or Ora is off); the daily teaser limit.';
