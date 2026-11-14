-- S47b: Ora proactive controls, the seven-day interaction history and remembered list choices (brief
-- S47b; spec "Confirmed Ora proactive frequency and category controls", "seven-day rolling
-- interaction history", "controlled long-term Ora memory").
--
--   public.ora_preferences     gains the person's frequency (Quiet / Balanced / Active), the three
--                              category switches and optional quiet hours (local time, may cross
--                              midnight). All personal: nobody, an Owner included, sets another
--                              member's;
--   public.ora_interactions    one short line per guided change or Undo, kept seven days. A row
--                              belongs to the membership of its place and goes with it; it is hidden
--                              from the person the moment they lose access to that Home. Expired rows
--                              are invisible to every read and purged when the person adds a row;
--   public.ora_memories        a remembered list choice ("add tasks here by default"), personal to
--                              the person and scoped to one place. Deleted with the membership.
-- Nothing here changes any task, shopping item or other module record.

alter table public.ora_preferences
  add column frequency text not null default 'balanced'
    constraint ora_preferences_frequency_check check (frequency in ('quiet', 'balanced', 'active')),
  add column cat_reminders boolean not null default true,
  add column cat_suggestions boolean not null default true,
  add column cat_celebrations boolean not null default true,
  -- 'HH:MM' local time; both set or both empty. start = end is not a window.
  add column quiet_start text
    constraint ora_preferences_quiet_start_check check (quiet_start ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  add column quiet_end text
    constraint ora_preferences_quiet_end_check check (quiet_end ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  add constraint ora_preferences_quiet_pair_check check (
    (quiet_start is null and quiet_end is null)
    or (quiet_start is not null and quiet_end is not null and quiet_start <> quiet_end)
  );

grant insert (frequency, cat_reminders, cat_suggestions, cat_celebrations, quiet_start, quiet_end)
  on table public.ora_preferences to authenticated;
grant update (frequency, cat_reminders, cat_suggestions, cat_celebrations, quiet_start, quiet_end)
  on table public.ora_preferences to authenticated;

-- Interaction history ---------------------------------------------------------------------------------

create table public.ora_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- 'personal' or the Home's id as text.
  scope text not null
    constraint ora_interactions_scope_check check (scope = 'personal' or scope ~ '^[0-9a-f-]{36}$'),
  home_id uuid,
  kind text not null
    constraint ora_interactions_kind_check check (kind in (
      'task-added', 'task-undone', 'shopping-item-added', 'shopping-item-undone'
    )),
  -- What the person typed (a title or a name), shown back to them only.
  label text not null
    constraint ora_interactions_label_check check (char_length(label) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint ora_interactions_home_check check (
    (scope = 'personal' and home_id is null) or (scope <> 'personal' and home_id is not null and home_id::text = scope)
  ),
  constraint ora_interactions_membership_fkey foreign key (home_id, user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

create index ora_interactions_user_idx on public.ora_interactions (user_id, created_at desc);

alter table public.ora_interactions enable row level security;

comment on table public.ora_interactions is
  'A person''s own short Ora history, seven days, per place; never a transcript (S47b).';

revoke all on table public.ora_interactions from anon, authenticated;
grant select on table public.ora_interactions to authenticated;
grant insert (user_id, scope, home_id, kind, label) on table public.ora_interactions to authenticated;
grant delete on table public.ora_interactions to authenticated;

create policy ora_interactions_select_own on public.ora_interactions
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and created_at > now() - interval '7 days'
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_interactions.home_id and m.user_id = (select auth.uid())
      )
    )
  );

create policy ora_interactions_insert_own on public.ora_interactions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_interactions.home_id and m.user_id = (select auth.uid())
      )
    )
  );

-- Clear recent interactions, and the purge of this person's expired rows (see the trigger below).
create policy ora_interactions_delete_own on public.ora_interactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- No cron is needed for the retention promise: every read already hides expired rows, and adding a
-- row removes this person's expired ones, so they do not linger.
create function private.purge_expired_ora_interactions() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from public.ora_interactions
      where user_id = new.user_id and created_at <= now() - interval '7 days';
    return null;
  end
  $$;

create trigger ora_interactions_purge_expired
  after insert on public.ora_interactions
  for each row execute function private.purge_expired_ora_interactions();

revoke all on function private.purge_expired_ora_interactions() from public, anon, authenticated;

-- Memories --------------------------------------------------------------------------------------------

create table public.ora_memories (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  scope text not null
    constraint ora_memories_scope_check check (scope = 'personal' or scope ~ '^[0-9a-f-]{36}$'),
  home_id uuid,
  -- The closed set of things Ora can remember: which list to preselect for a guided change.
  key text not null
    constraint ora_memories_key_check check (key in ('task-list', 'shopping-list')),
  list_id uuid not null,
  -- The list's name when it was saved, so the memory can be read and corrected without opening
  -- the module; the name is the person's own (or the Home's) and is shown only to them.
  list_name text not null
    constraint ora_memories_list_name_check check (char_length(list_name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ora_memories_pkey primary key (user_id, scope, key),
  constraint ora_memories_home_check check (
    (scope = 'personal' and home_id is null) or (scope <> 'personal' and home_id is not null and home_id::text = scope)
  ),
  constraint ora_memories_membership_fkey foreign key (home_id, user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

alter table public.ora_memories enable row level security;

comment on table public.ora_memories is
  'A remembered list choice for one person in one place; personal, never shared (S47b).';

create trigger ora_memories_set_updated_at
  before update on public.ora_memories
  for each row execute function private.set_updated_at();

revoke all on table public.ora_memories from anon, authenticated;
grant select on table public.ora_memories to authenticated;
grant insert (user_id, scope, home_id, key, list_id, list_name)
  on table public.ora_memories to authenticated;
grant update (user_id, scope, home_id, key, list_id, list_name)
  on table public.ora_memories to authenticated;
grant delete on table public.ora_memories to authenticated;

create policy ora_memories_select_own on public.ora_memories
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_memories.home_id and m.user_id = (select auth.uid())
      )
    )
  );

create policy ora_memories_insert_own on public.ora_memories
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_memories.home_id and m.user_id = (select auth.uid())
      )
    )
  );

create policy ora_memories_update_own on public.ora_memories
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_memories.home_id and m.user_id = (select auth.uid())
      )
    )
  )
  with check (
    user_id = (select auth.uid())
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = ora_memories.home_id and m.user_id = (select auth.uid())
      )
    )
  );

-- Deleting a memory needs no Home check: removing your own remembered choice is always allowed.
create policy ora_memories_delete_own on public.ora_memories
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- A memory stays in its place: an update may not move it to another Home or person (the app's upsert
-- names every column in its update, so they keep their grant, unchanged).
create function private.keep_ora_memory_place() returns trigger
  language plpgsql set search_path = '' as $$
  begin
    if new.scope is distinct from old.scope or new.home_id is distinct from old.home_id
       or new.user_id is distinct from old.user_id or new.key is distinct from old.key then
      raise exception 'an Ora memory cannot move to another place or person'
        using errcode = '42501';
    end if;
    return new;
  end
  $$;

create trigger ora_memories_keep_place
  before update on public.ora_memories
  for each row execute function private.keep_ora_memory_place();

-- The same gap in S47's dismissals: a Home-looking scope with no Home skipped the membership checks.
alter table public.ora_dismissed_suggestions drop constraint ora_dismissed_home_check;
alter table public.ora_dismissed_suggestions add constraint ora_dismissed_home_check check (
  (scope = 'personal' and home_id is null)
  or (scope <> 'personal' and home_id is not null and home_id::text = scope)
);
