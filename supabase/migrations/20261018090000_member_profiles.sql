-- S11: member directory, Home-specific names and personal accent colours (brief S11; spec
-- "Confirmed global adult avatar and display name with per-Home overrides", "Confirmed simple Home
-- member directory", "Confirmed optional per-Home nicknames", "Confirmed personal accent color with
-- per-Home overrides", "Confirmed global identity with Home-specific profile presentation").
--
-- What the API can do here, and nothing more:
-- - set its own global accent colour (user_preferences.accent_color, existing RLS);
-- - read, create and change its own presentation in a Home it currently belongs to: nickname, Home
--   display name and accent override (public.home_member_profiles, RLS below). Nobody, whatever
--   their role, can write another person's row;
-- - list the current members of a Home it belongs to through public.home_directory(), which
--   returns only what other members may see: membership id, role, the date they joined, the
--   effective Home name and colour. Never account ids, emails or other Homes.

-- One name rule -----------------------------------------------------------------------------------

-- The visible-name policy for every name other people see (apps/web/src/names/visible-name.ts;
-- the S09 Home-name rule, unchanged). Home names, global display names and the two Home-specific
-- names all check it here, so the rules cannot drift apart. The app applies the exact Unicode rules
-- first; this is the backstop for direct Data API writes. It can only list code points, so for lone
-- combining marks of rarer scripts it is a little more lenient than the app.
--   * 1 to p_max characters, NFC, no leading or trailing whitespace of any kind;
--   * no control, format or other invisible characters: zero-width spaces, direction marks,
--     overrides and isolates, word joiners, BOMs, soft hyphens, Hangul fillers, the Braille
--     blank, Mongolian selectors, line and paragraph separators;
--   * a zero-width joiner or non-joiner only between two visible characters, and a variation
--     selector only directly after one (emoji sequences, Persian and Indic text);
--   * tag characters only inside a complete emoji tag flag (U+1F3F4 ... U+E007F);
--   * at least one character that is not whitespace, a joiner, a selector or a combining mark.
create or replace function private.is_visible_name(p_name text, p_max integer) returns boolean
  language sql immutable strict parallel safe set search_path = '' as $$
    select pg_catalog.char_length(p_name) between 1 and p_max
      and p_name is nfc normalized
      and p_name !~ '^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]'
      and p_name !~ '[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]$'
      and p_name !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E001F\U000E0080-\U000E00FF\U000E01F0-\U000E0FFF]'
      and p_name !~ '^[\u200C\u200D\uFE00-\uFE0F\U000E0100-\U000E01EF]|[\u200C\u200D]$|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200C\u200D][\u200C\u200D]|[\u200C\u200D][\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFE00-\uFE0F\U000E0100-\U000E01EF]|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200C\u200D\uFE00-\uFE0F\U000E0100-\U000E01EF][\uFE00-\uFE0F\U000E0100-\U000E01EF]'
      and pg_catalog.regexp_replace(p_name, '\U0001F3F4[\U000E0020-\U000E007E]+\U000E007F', '', 'g')
        !~ '[\U000E0020-\U000E007F]'
      and p_name ~ '[^\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200C\u200D\uFE00-\uFE0F\U000E0100-\U000E01EF\U000E0020-\U000E007F\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]'
  $$;

comment on function private.is_visible_name(text, integer) is
  'S11: the visible-name rule for names other people see (Home names, display names, nicknames).';

-- `create or replace`, so the file can be applied again after the owner guide's undo block, which
-- keeps this function because the name checks below still use it.
-- Check constraints run their functions with the privileges of whoever writes the row, so the
-- signed-in API role must be able to execute it. It is pure: it reads nothing and reveals nothing.
-- Allowlisted in tests/db/rls/baseline.test.sql.
revoke all on function private.is_visible_name(text, integer) from public, anon;
grant execute on function private.is_visible_name(text, integer) to authenticated, service_role;

-- Home names keep exactly the S09 rule, now from the shared function.
alter table public.homes drop constraint homes_name_check;
alter table public.homes
  add constraint homes_name_check check (private.is_visible_name(name, 50));

-- Global display names --------------------------------------------------------------------------

-- Display names become visible to other members with this step, so they follow the same rule
-- (S07 review M1, deferred to S11). A stored name the new rule refuses is cleared, because the new
-- check would otherwise refuse every later preference save of that account. Only names with
-- invisible or direction characters are affected; the person can type their name again.
alter table public.user_preferences drop constraint user_preferences_display_name_check;
update public.user_preferences
  set display_name = null
  where display_name is not null and not private.is_visible_name(display_name, 50);
alter table public.user_preferences
  add constraint user_preferences_display_name_check
    check (display_name is null or private.is_visible_name(display_name, 50));

-- The global personal accent: a solid colour as lower-case #rrggbb (the app derives every shade
-- from it with deriveAccent). NULL means the default accent.
alter table public.user_preferences
  add column accent_color text
    constraint user_preferences_accent_color_check check (accent_color ~ '^#[0-9a-f]{6}$');

grant insert (accent_color), update (accent_color) on table public.user_preferences
  to authenticated;

-- Home presentation -------------------------------------------------------------------------------

-- How one member presents themselves in one Home. Each field is optional and NULL means "inherit":
-- the effective Home name is the nickname, else the Home display name, else the global display
-- name; the effective colour is the accent override, else the global accent. The row belongs to
-- the membership: when the membership ends (leaving, removal, account deletion) it is deleted with
-- it, so overrides never survive a departure or reappear on a later re-join.
create table public.home_member_profiles (
  home_id uuid not null,
  user_id uuid not null default auth.uid(),
  nickname text
    constraint home_member_profiles_nickname_check
      check (nickname is null or private.is_visible_name(nickname, 50)),
  display_name text
    constraint home_member_profiles_display_name_check
      check (display_name is null or private.is_visible_name(display_name, 50)),
  accent_color text
    constraint home_member_profiles_accent_color_check check (accent_color ~ '^#[0-9a-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint home_member_profiles_pkey primary key (home_id, user_id),
  constraint home_member_profiles_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);

alter table public.home_member_profiles enable row level security;

comment on table public.home_member_profiles is
  'A member''s own presentation in one Home: nickname, Home display name, accent (S11).';

create trigger home_member_profiles_set_updated_at
  before update on public.home_member_profiles
  for each row execute function private.set_updated_at();

-- A row stays with its membership: an update may not move it to another Home or person. The Data
-- API's upsert names home_id and user_id in its update, so they keep their grant, unchanged.
create function private.keep_home_member_profile_owner() returns trigger
  language plpgsql set search_path = '' as $$
  begin
    if new.home_id is distinct from old.home_id or new.user_id is distinct from old.user_id then
      raise exception 'a Home profile cannot move to another Home or person'
        using errcode = '42501';
    end if;
    return new;
  end
  $$;

create trigger home_member_profiles_keep_owner
  before update on public.home_member_profiles
  for each row execute function private.keep_home_member_profile_owner();

-- Supabase grants every API role full access to new tables in schema public. Take that back and
-- grant only what the app needs: the person reads their own rows and writes the three presentation
-- columns (home_id and user_id on insert, so an upsert works; the policies stop them naming anyone
-- else). Resetting a field writes NULL; nobody deletes a row through the API.
revoke all on table public.home_member_profiles from anon, authenticated;
grant select (home_id, user_id, nickname, display_name, accent_color, created_at, updated_at)
  on table public.home_member_profiles to authenticated;
grant insert (home_id, user_id, nickname, display_name, accent_color)
  on table public.home_member_profiles to authenticated;
grant update (home_id, user_id, nickname, display_name, accent_color)
  on table public.home_member_profiles to authenticated;

-- Only your own row, and only while you are a current member of that Home. The membership subquery
-- runs as the same person, whose home_memberships policy shows them their own rows only. Owners and
-- Administrators get nothing here: nobody may present another adult (spec: managers cannot rename
-- or recolour another adult).
create policy home_member_profiles_select_own on public.home_member_profiles
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  );

create policy home_member_profiles_insert_own on public.home_member_profiles
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  );

create policy home_member_profiles_update_own on public.home_member_profiles
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  );

-- Member directory --------------------------------------------------------------------------------

-- The current members of one Home with what every member of that Home may see about them, for a
-- caller who is a current member of it now. Anyone else gets an error (42501), whether or not the
-- Home exists. Other people's global display names and accents live in rows only their owner can
-- read, so this function reads them as the database owner and returns only the effective values:
-- never which source a name came from, the global name behind an override, account ids, emails or
-- anything from another Home. membership_id is the stable Home-member identifier for attribution.
create function public.home_directory(p_home_id uuid)
returns table (
  membership_id uuid,
  role text,
  joined_at timestamptz,
  is_self boolean,
  name text,
  accent_color text
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or p_home_id is null or not exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      raise exception 'not a member of this Home' using errcode = '42501';
    end if;

    return query
      select
        m.id,
        m.role,
        m.created_at,
        m.user_id = v_user_id,
        coalesce(p.nickname, p.display_name, up.display_name),
        coalesce(p.accent_color, up.accent_color)
      from public.home_memberships m
      left join public.home_member_profiles p
        on p.home_id = m.home_id and p.user_id = m.user_id
      left join public.user_preferences up on up.user_id = m.user_id
      where m.home_id = p_home_id
      order by m.created_at, m.id;
  end
  $$;

comment on function public.home_directory(uuid) is
  'S11: the members of a Home the caller belongs to, with their effective name and colour only.';

revoke all on function public.home_directory(uuid) from public, anon;
grant execute on function public.home_directory(uuid) to authenticated;
