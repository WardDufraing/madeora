-- S45: Ora settings (brief S45; spec "Confirmed personal Ora hide and disable control", "Confirmed
-- Ora lightweight first-use introduction"; Ora design handoff: nine palettes per person per Home,
-- one personal motion mode).
--
-- Two small tables, both readable and writable only by the person they belong to:
--   public.ora_preferences   one row per person: Ora on/off, motion mode, whether the first-use
--                            introduction is finished, and the colour used in Personal space;
--   public.ora_home_palettes the colour the person chose in one Home. It belongs to the membership
--                            and goes with it (leaving, removal, Home deletion), so a colour never
--                            survives a departure or reappears on a later re-join.
-- Nobody, an Owner included, reads or sets another member's Ora settings. Rows are created on first
-- save; a missing row means the defaults (enabled, gentle motion, introduction not seen, Heather).
-- Disabling Ora changes nothing else: the settings stay and nothing is deleted.
--
-- The allowed palette keys mirror packages/design-tokens/src/ora.ts; the app validates first and
-- these checks keep direct Data API writes well-formed.

create table public.ora_preferences (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  motion text not null default 'gentle'
    constraint ora_preferences_motion_check check (motion in ('gentle', 'reactions', 'none')),
  -- NULL = the introduction has not been seen; once set it is never repeated for this person.
  intro text
    constraint ora_preferences_intro_check check (intro in ('completed', 'skipped')),
  personal_palette text not null default 'heather'
    constraint ora_preferences_personal_palette_check check (personal_palette in (
      'muted-teal', 'denim', 'terracotta', 'olive', 'ochre', 'heather', 'brick', 'petrol', 'cocoa'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ora_preferences enable row level security;

comment on table public.ora_preferences is
  'A person''s own Ora settings: on/off, motion mode, introduction state, Personal colour (S45).';

create trigger ora_preferences_set_updated_at
  before update on public.ora_preferences
  for each row execute function private.set_updated_at();

revoke all on table public.ora_preferences from anon, authenticated;
grant select on table public.ora_preferences to authenticated;
grant insert (user_id, enabled, motion, intro, personal_palette)
  on table public.ora_preferences to authenticated;
grant update (user_id, enabled, motion, intro, personal_palette)
  on table public.ora_preferences to authenticated;

create policy ora_preferences_select_own on public.ora_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy ora_preferences_insert_own on public.ora_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy ora_preferences_update_own on public.ora_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Per-Home colour -----------------------------------------------------------------------------------

create table public.ora_home_palettes (
  home_id uuid not null,
  user_id uuid not null default auth.uid(),
  palette text not null
    constraint ora_home_palettes_palette_check check (palette in (
      'muted-teal', 'denim', 'terracotta', 'olive', 'ochre', 'heather', 'brick', 'petrol', 'cocoa'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ora_home_palettes_pkey primary key (home_id, user_id),
  constraint ora_home_palettes_membership_fkey foreign key (home_id, user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

alter table public.ora_home_palettes enable row level security;

comment on table public.ora_home_palettes is
  'The Ora colour one member chose in one Home; deleted with the membership (S45).';

create trigger ora_home_palettes_set_updated_at
  before update on public.ora_home_palettes
  for each row execute function private.set_updated_at();

-- A row stays with its membership: an update may not move it to another Home or person (the Data
-- API's upsert names both keys in its update, so they keep their grant, unchanged).
create function private.keep_ora_home_palette_owner() returns trigger
  language plpgsql set search_path = '' as $$
  begin
    if new.home_id is distinct from old.home_id or new.user_id is distinct from old.user_id then
      raise exception 'an Ora colour cannot move to another Home or person'
        using errcode = '42501';
    end if;
    return new;
  end
  $$;

create trigger ora_home_palettes_keep_owner
  before update on public.ora_home_palettes
  for each row execute function private.keep_ora_home_palette_owner();

revoke all on table public.ora_home_palettes from anon, authenticated;
grant select on table public.ora_home_palettes to authenticated;
grant insert (home_id, user_id, palette) on table public.ora_home_palettes to authenticated;
grant update (home_id, user_id, palette) on table public.ora_home_palettes to authenticated;

-- Only your own row, and only while you are a current member of that Home (public.home_memberships
-- leaves out Homes that are closed for the person).
create policy ora_home_palettes_select_own on public.ora_home_palettes
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = ora_home_palettes.home_id and m.user_id = (select auth.uid())
    )
  );

create policy ora_home_palettes_insert_own on public.ora_home_palettes
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = ora_home_palettes.home_id and m.user_id = (select auth.uid())
    )
  );

create policy ora_home_palettes_update_own on public.ora_home_palettes
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = ora_home_palettes.home_id and m.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = ora_home_palettes.home_id and m.user_id = (select auth.uid())
    )
  );
