-- S07: global personal preferences (architecture.md §4 `user_preferences`; brief S07).
--
-- One row per account with the preferences that are the same on every device and in every Home:
-- display name, interface language, regional formats and a chosen timezone. The row is created on
-- the first save; until then the app uses the defaults. NULL means "not chosen" for the language
-- and "Automatic" for the formats and the timezone, so returning a setting to Automatic restores
-- the current detected default, and nothing a device, language or Home does can overwrite a
-- custom choice (spec, "Confirmed automatic regional defaults", "Confirmed personal timezone").
--
-- The allowed values mirror apps/web/src/preferences/schema.ts. The app validates first; these
-- constraints keep direct Data API writes well-formed too.

create table public.user_preferences (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text
    constraint user_preferences_display_name_check check (
      char_length(display_name) between 1 and 50
      and display_name = btrim(display_name)
      and display_name is nfc normalized
      -- No control characters, line or paragraph separators, or direction marks, overrides and
      -- isolates that could disguise a name. Exactly the code points the app refuses (schema.ts).
      and display_name !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]'
    ),
  locale text
    constraint user_preferences_locale_check check (locale in ('en', 'nl')),
  date_format text
    constraint user_preferences_date_format_check check (
      date_format in ('dmy-slash', 'dmy-dash', 'dmy-dot', 'mdy-slash', 'ymd-dash')
    ),
  time_format text
    constraint user_preferences_time_format_check check (time_format in ('24h', '12h')),
  week_start text
    constraint user_preferences_week_start_check check (
      week_start in ('monday', 'saturday', 'sunday')
    ),
  number_format text
    constraint user_preferences_number_format_check check (
      number_format in ('comma-dot', 'dot-comma', 'space-comma')
    ),
  measurement_system text
    constraint user_preferences_measurement_system_check check (
      measurement_system in ('metric', 'us-customary')
    ),
  -- An IANA zone name such as Europe/Brussels. The app also checks the zone exists; the database
  -- only checks its shape, because PostgreSQL's and the browsers' zone lists differ slightly.
  timezone text
    constraint user_preferences_timezone_check check (
      char_length(timezone) <= 64
      and timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Row level security from the start, before any role is granted access.
alter table public.user_preferences enable row level security;

comment on table public.user_preferences is
  'Global personal preferences of one account (S07). NULL = not chosen / Automatic.';

-- updated_at is set by the database, never by the client.
create function private.set_updated_at() returns trigger
  language plpgsql
  set search_path = ''
  as $$
  begin
    new.updated_at := now();
    return new;
  end
  $$;

create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute function private.set_updated_at();

-- Supabase grants every API role full access to new tables in schema public. Take that back and
-- grant only what the app needs: signed-in people read their row and write the preference columns
-- (user_id included, so an upsert works; the policies below stop it from naming anyone else).
-- created_at and updated_at stay out of reach. Nobody deletes a row through the API: it goes with
-- the account.
revoke all on table public.user_preferences from anon, authenticated;
grant select on table public.user_preferences to authenticated;
grant insert (
  user_id, display_name, locale, date_format, time_format, week_start, number_format,
  measurement_system, timezone
) on table public.user_preferences to authenticated;
grant update (
  user_id, display_name, locale, date_format, time_format, week_start, number_format,
  measurement_system, timezone
) on table public.user_preferences to authenticated;

create policy user_preferences_select_own on public.user_preferences
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy user_preferences_insert_own on public.user_preferences
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy user_preferences_update_own on public.user_preferences
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
