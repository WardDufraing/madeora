-- S09: Homes, memberships with exactly one Owner, and the audit log (architecture.md section 4; brief
-- S09; spec "Confirmed multi-Home model", "Confirmed Home roles", "Confirmed exactly one Home
-- Owner").
--
-- What the API can do here, and nothing more:
-- - read a Home it is a current member of, and its own memberships (RLS below);
-- - create a Home through public.create_home(), which makes the caller its single Owner in one
--   transaction;
-- - change a Home's name and scheduling timezone, as that Home's Owner (RLS below).
-- Nobody inserts, changes or deletes a membership through the API: joining (S10) and role changes,
-- removal and ownership transfer (S12) arrive with their own reviewed functions. Every change to
-- either table is written to private.audit_events by triggers, whichever path made it.

-- Homes ------------------------------------------------------------------------------------------

create table public.homes (
  id uuid primary key default gen_random_uuid(),
  -- A Home's name is shown to every member, so it follows the stricter name policy that S07's
  -- review deferred to the first names other people see (apps/web/src/names/visible-name.ts; the
  -- app applies the exact Unicode rules, this check is the backstop for direct API writes):
  --   * 1 to 50 characters, NFC, no leading or trailing whitespace of any kind;
  --   * no control, format or other invisible characters: zero-width spaces, direction marks,
  --     overrides and isolates, word joiners, BOMs, soft hyphens, Hangul fillers, the Braille
  --     blank, Mongolian selectors, line and paragraph separators;
  --   * a zero-width joiner or non-joiner only between two visible characters, and a variation
  --     selector only directly after one (emoji sequences, Persian and Indic text);
  --   * tag characters only inside a complete emoji tag flag (U+1F3F4 ... U+E007F);
  --   * at least one character that is not whitespace, a joiner, a selector or a combining mark.
  name text not null
    constraint homes_name_check check (
      char_length(name) between 1 and 50
      and name is nfc normalized
      and name !~ '^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]'
      and name !~ '[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]$'
      and name !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E001F\U000E0080-\U000E00FF\U000E01F0-\U000E0FFF]'
      and name !~ '^[\u200C\u200D\uFE00-\uFE0F\U000E0100-\U000E01EF]|[\u200C\u200D]$|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200C\u200D][\u200C\u200D]|[\u200C\u200D][\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFE00-\uFE0F\U000E0100-\U000E01EF]|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200C\u200D\uFE00-\uFE0F\U000E0100-\U000E01EF][\uFE00-\uFE0F\U000E0100-\U000E01EF]'
      and regexp_replace(name, '\U0001F3F4[\U000E0020-\U000E007E]+\U000E007F', '', 'g')
        !~ '[\U000E0020-\U000E007F]'
      and name ~ '[^\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200C\u200D\uFE00-\uFE0F\U000E0100-\U000E01EF\U000E0020-\U000E007F\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]'
    ),
  -- The Home's scheduling timezone (spec "Confirmed personal timezone": Home-anchored schedules
  -- use it, whoever views them). Same shape check as user_preferences.timezone; the app also
  -- checks the zone exists.
  timezone text not null
    constraint homes_timezone_check check (
      char_length(timezone) <= 64
      and timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    ),
  -- Who created it. Kept for duplicate-request detection only; ownership lives in
  -- home_memberships, and the creator may later stop being the Owner (S12).
  created_by uuid references auth.users (id) on delete set null,
  -- The id the app generates once per Create a Home form, so a double click or a retry after a
  -- lost response returns the same Home instead of creating a second one.
  creation_request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index homes_creation_request_key on public.homes (created_by, creation_request_id);

alter table public.homes enable row level security;

comment on table public.homes is
  'A Home: an isolated shared context with its own members, roles and data (S09).';

create trigger homes_set_updated_at
  before update on public.homes
  for each row execute function private.set_updated_at();

-- Memberships --------------------------------------------------------------------------------------

create table public.home_memberships (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  -- Deleting an account removes its memberships; for a Home's only Owner the Owner check below
  -- refuses that until transfer-or-close exists (S12, S40).
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null
    constraint home_memberships_role_check check (role in ('owner', 'administrator', 'member')),
  created_at timestamptz not null default now(),
  constraint home_memberships_home_user_key unique (home_id, user_id)
);

-- At most one Owner per Home. The deferred trigger below makes it at least one.
create unique index home_memberships_one_owner on public.home_memberships (home_id)
  where role = 'owner';

-- "Which Homes am I in" is the query every page runs.
create index home_memberships_user_id_idx on public.home_memberships (user_id);

alter table public.home_memberships enable row level security;

comment on table public.home_memberships is
  'Current Home memberships with their role; exactly one Owner per Home (S09).';

-- Exactly one Owner -------------------------------------------------------------------------------

-- Checked at commit, so a transaction may create a Home before its Owner membership, or (S12)
-- swap two roles, but can never finish with a Home that has no Owner. A Home that no longer exists
-- (deleted with its memberships) needs no Owner.
create function private.check_home_has_owner() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_home_id uuid;
  begin
    if tg_table_name = 'homes' then
      v_home_id := new.id;
    else
      v_home_id := old.home_id;
    end if;

    if exists (select 1 from public.homes h where h.id = v_home_id)
       and not exists (
         select 1 from public.home_memberships m
         where m.home_id = v_home_id and m.role = 'owner'
       ) then
      raise exception 'a Home must always have an Owner'
        using errcode = '23514',
              hint = 'Ownership changes only through an accepted transfer (S12).';
    end if;
    return null;
  end
  $$;

create constraint trigger homes_owner_required
  after insert on public.homes
  deferrable initially deferred
  for each row execute function private.check_home_has_owner();

create constraint trigger home_memberships_owner_required
  after update or delete on public.home_memberships
  deferrable initially deferred
  for each row execute function private.check_home_has_owner();

-- Audit log ---------------------------------------------------------------------------------------

-- Who did what, in which Home, to which subject, and when (architecture.md section 4). Identities are
-- stable ids, never names or colours. Not reachable through the API: schema private is not
-- exposed and nothing is granted. Details are minimal (field names and roles, never the names or
-- other content people typed). Retention is still open in the spec; nothing deletes rows yet.
create table private.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  -- The signed-in account that made the change; null for the database owner or the service role
  -- acting without a user (migrations, maintenance).
  actor_user_id uuid,
  -- No foreign keys: the record must outlive the Home and the accounts it mentions (deletion and
  -- anonymisation rules arrive with S40).
  home_id uuid,
  action text not null
    constraint audit_events_action_check check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  subject_type text not null
    constraint audit_events_subject_type_check check (subject_type in ('home', 'user')),
  subject_id uuid,
  details jsonb not null default '{}'::jsonb
    constraint audit_events_details_check check (jsonb_typeof(details) = 'object')
);

create index audit_events_home_id_idx on private.audit_events (home_id, occurred_at);

revoke all on table private.audit_events from public;

comment on table private.audit_events is
  'Restricted audit trail of Home and membership changes (S09). Not exposed through the API.';

create function private.audit_home_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_fields text[] := array[]::text[];
  begin
    if tg_op = 'INSERT' then
      insert into private.audit_events (actor_user_id, home_id, action, subject_type, subject_id)
        values (auth.uid(), new.id, 'home.created', 'home', new.id);
    elsif tg_op = 'UPDATE' then
      if new.name is distinct from old.name then
        v_fields := v_fields || 'name'::text;
      end if;
      if new.timezone is distinct from old.timezone then
        v_fields := v_fields || 'timezone'::text;
      end if;
      if pg_catalog.cardinality(v_fields) > 0 then
        insert into private.audit_events (
          actor_user_id, home_id, action, subject_type, subject_id, details
        )
          values (
            auth.uid(), new.id, 'home.settings_changed', 'home', new.id,
            pg_catalog.jsonb_build_object('fields', pg_catalog.to_jsonb(v_fields))
          );
      end if;
    end if;
    return null;
  end
  $$;

create trigger homes_audit
  after insert or update on public.homes
  for each row execute function private.audit_home_change();

create function private.audit_membership_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if tg_op = 'INSERT' then
      insert into private.audit_events (
        actor_user_id, home_id, action, subject_type, subject_id, details
      )
        values (
          auth.uid(), new.home_id, 'home_membership.created', 'user', new.user_id,
          pg_catalog.jsonb_build_object('role', new.role)
        );
    elsif tg_op = 'UPDATE' then
      if new.role is distinct from old.role then
        insert into private.audit_events (
          actor_user_id, home_id, action, subject_type, subject_id, details
        )
          values (
            auth.uid(), new.home_id, 'home_membership.role_changed', 'user', new.user_id,
            pg_catalog.jsonb_build_object('from', old.role, 'to', new.role)
          );
      end if;
    else
      insert into private.audit_events (
        actor_user_id, home_id, action, subject_type, subject_id, details
      )
        values (
          auth.uid(), old.home_id, 'home_membership.ended', 'user', old.user_id,
          pg_catalog.jsonb_build_object('role', old.role)
        );
    end if;
    return null;
  end
  $$;

create trigger home_memberships_audit
  after insert or update or delete on public.home_memberships
  for each row execute function private.audit_membership_change();

-- API access --------------------------------------------------------------------------------------

-- Supabase grants every API role full access to new tables in schema public. Take that back and
-- grant only what the app needs. created_by and creation_request_id stay out of reach: members do
-- not need to know who created a Home, and request ids are the creator's own business.
revoke all on table public.homes from anon, authenticated;
revoke all on table public.home_memberships from anon, authenticated;

grant select (id, name, timezone, created_at, updated_at) on table public.homes to authenticated;
grant update (name, timezone) on table public.homes to authenticated;
grant select (id, home_id, user_id, role, created_at) on table public.home_memberships
  to authenticated;

-- A Home is visible only to its current members. The subquery reads home_memberships as the same
-- person, whose policy below shows them their own rows only, so it finds exactly their membership.
create policy homes_select_member on public.homes
  for select
  to authenticated
  using (
    exists (
      select 1 from public.home_memberships m
      where m.home_id = homes.id and m.user_id = (select auth.uid())
    )
  );

-- Only the Owner changes a Home's settings. Administrators get this through a capability the Owner
-- grants (S12), never through the role alone (spec "Confirmed customizable Administrator
-- permissions"). The TypeScript engine (packages/domain) makes the same decision first.
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

-- Each person sees their own memberships only. The member directory, with other people's rows,
-- arrives in S11 with its own policy and tests.
create policy home_memberships_select_own on public.home_memberships
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Create a Home ----------------------------------------------------------------------------------

-- Creates a Home and makes the caller its single Owner, atomically. A repeated p_request_id from
-- the same account returns the Home that request already created, so retries and double clicks
-- never make two. Only signed-in accounts with a confirmed email may call it; every account is an
-- adult until children (S41) and Household Displays (S43) arrive, which must be refused here then.
-- The name and timezone are checked by the table's constraints (the app normalises them first).
create function public.create_home(p_name text, p_timezone text, p_request_id uuid)
returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_home_id uuid;
  begin
    if v_user_id is null or not exists (
      select 1 from auth.users u where u.id = v_user_id and u.email_confirmed_at is not null
    ) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_request_id is null then
      raise exception 'a request id is required' using errcode = '22023';
    end if;

    -- One creation at a time per account, so two concurrent retries of one request cannot both
    -- miss the existing Home and then collide on the unique index.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('madeora.create_home:' || v_user_id::text, 0)
    );

    select h.id into v_home_id
      from public.homes h
      where h.created_by = v_user_id and h.creation_request_id = p_request_id;
    if v_home_id is not null then
      return v_home_id;
    end if;

    insert into public.homes (name, timezone, created_by, creation_request_id)
      values (p_name, p_timezone, v_user_id, p_request_id)
      returning id into v_home_id;
    insert into public.home_memberships (home_id, user_id, role)
      values (v_home_id, v_user_id, 'owner');
    return v_home_id;
  end
  $$;

comment on function public.create_home(text, text, uuid) is
  'S09: create a Home and become its single Owner; idempotent per request id.';

revoke all on function public.create_home(text, text, uuid) from public, anon;
grant execute on function public.create_home(text, text, uuid) to authenticated;
