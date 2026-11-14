-- S47b: Ora proactive controls, the seven-day history and remembered list choices
-- (supabase/migrations/20261208090000_ora_controls_history_memories.sql). Alice, Bob and Carol are
-- seeded synthetic accounts. Everything is personal: only the person reads or changes their own
-- rows, history older than seven days is invisible and purged, and leaving a Home deletes that
-- Home's lines and memories.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
-- Alice is a Member of Bob's Home, so she can leave it later (a sole Owner cannot).
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'member');

-- Signed-out visitors ------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied('select id from public.ora_interactions',
  'A signed-out visitor cannot read history');
select tests.assert_denied('select key from public.ora_memories',
  'A signed-out visitor cannot read memories');

-- Controls ---------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_allowed(
  $$insert into public.ora_preferences
      (user_id, frequency, cat_reminders, cat_suggestions, cat_celebrations, quiet_start, quiet_end)
    values (tests.user_id('alice'), 'quiet', false, true, false, '22:00', '07:00')
    on conflict (user_id) do update
      set user_id = excluded.user_id, frequency = excluded.frequency,
          cat_reminders = excluded.cat_reminders, cat_suggestions = excluded.cat_suggestions,
          cat_celebrations = excluded.cat_celebrations, quiet_start = excluded.quiet_start,
          quiet_end = excluded.quiet_end$$,
  'Alice can set frequency, categories and quiet hours (the app''s upsert)'
);
select tests.assert_denied(
  $$update public.ora_preferences set frequency = 'loud' where user_id = tests.user_id('alice')$$,
  'An unknown frequency is refused', '23514'
);
select tests.assert_denied(
  $$update public.ora_preferences set quiet_start = '9:00' where user_id = tests.user_id('alice')$$,
  'A malformed time is refused', '23514'
);
select tests.assert_denied(
  $$update public.ora_preferences set quiet_end = null where user_id = tests.user_id('alice')$$,
  'Quiet hours need both times or neither', '23514'
);
select tests.assert_denied(
  $$update public.ora_preferences set quiet_start = '07:00' where user_id = tests.user_id('alice')$$,
  'Quiet hours may not start and end at the same time', '23514'
);
select tests.assert_allowed(
  $$update public.ora_preferences set quiet_start = null, quiet_end = null
    where user_id = tests.user_id('alice')$$,
  'Quiet hours can be turned off'
);
select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_preferences', 0,
  'Bob never reads Alice''s controls, an Owner of her other Home included');

-- History ----------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_allowed(
  $$insert into public.ora_interactions (scope, kind, label)
    values ('personal', 'task-added', 'Water the plants')$$,
  'Alice can add a history line in Personal space'
);
select tests.assert_allowed(
  $$insert into public.ora_interactions (scope, home_id, kind, label)
    values ((select id::text from ids where name = 'home-b'),
            (select id from ids where name = 'home-b'), 'shopping-item-added', 'Milk')$$,
  'Alice can add one in a Home she belongs to'
);
select tests.assert_row_count('select * from public.ora_interactions', 2,
  'Alice reads her own two lines');
select tests.assert_denied(
  $$insert into public.ora_interactions (scope, kind, label) values ('personal', 'chat', 'hi')$$,
  'Only the closed set of kinds is allowed', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_interactions (scope, kind, label) values ('personal', 'task-added', '')$$,
  'An empty line is refused', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_interactions (scope, home_id, kind, label)
    values ('personal', (select id from ids where name = 'home-b'), 'task-added', 'x')$$,
  'A place and its Home must agree', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_interactions (scope, kind, label)
    values ((select id::text from ids where name = 'home-b'), 'task-added', 'x')$$,
  'A Home scope without its Home is refused', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_interactions (user_id, scope, kind, label)
    values (tests.user_id('bob'), 'personal', 'task-added', 'x')$$,
  'Alice cannot write a line for Bob'
);
select tests.assert_denied(
  $$update public.ora_interactions set label = 'changed' where user_id = tests.user_id('alice')$$,
  'A line is never edited'
);

select tests.act_as('carol');
select tests.assert_denied(
  $$insert into public.ora_interactions (scope, home_id, kind, label)
    values ((select id::text from ids where name = 'home-b'),
            (select id from ids where name = 'home-b'), 'task-added', 'x')$$,
  'Carol cannot add a line in a Home she does not belong to'
);
select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_interactions', 0,
  'Bob cannot read Alice''s history, an Owner of that Home included');
select tests.assert_row_count(
  $$delete from public.ora_interactions returning id$$, 0,
  'Bob cannot delete Alice''s history'
);

-- Seven days ---------------------------------------------------------------------------------------------

select tests.act_as_owner();
-- The purge trigger would remove the old row as it is inserted; switch it off for the fixture only.
alter table public.ora_interactions disable trigger ora_interactions_purge_expired;
insert into public.ora_interactions (user_id, scope, kind, label, created_at)
  values (tests.user_id('alice'), 'personal', 'task-added', 'Old line', now() - interval '8 days');
alter table public.ora_interactions enable trigger ora_interactions_purge_expired;
select tests.assert_row_count(
  $$select * from public.ora_interactions where label = 'Old line'$$, 1,
  'Fixture: the old line exists'
);
select tests.act_as('alice');
select tests.assert_row_count($$select * from public.ora_interactions where label = 'Old line'$$, 0,
  'A line older than seven days is invisible');
select tests.assert_allowed(
  $$insert into public.ora_interactions (scope, kind, label)
    values ('personal', 'task-undone', 'Water the plants')$$,
  'Adding a line purges her expired ones'
);
select tests.act_as_owner();
select tests.assert_row_count(
  $$select * from public.ora_interactions where label = 'Old line'$$, 0,
  'The expired line is physically gone after the next insert'
);

-- Clear recent interactions ----------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_allowed(
  $$insert into public.ora_interactions (scope, kind, label) values ('personal', 'task-added', 'Bob')$$,
  'Bob has a line of his own'
);
select tests.act_as('alice');
select tests.assert_allowed('delete from public.ora_interactions',
  'Alice can clear her own history');
select tests.assert_row_count('select * from public.ora_interactions', 0, 'Alice has no lines left');
select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_interactions', 1,
  'Clearing Alice''s history left Bob''s alone');

-- Memories -------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_allowed(
  $$insert into public.ora_memories (scope, home_id, key, list_id, list_name)
    values ('personal', null, 'task-list', gen_random_uuid(), 'Inbox')
    on conflict (user_id, scope, key) do update
      set scope = excluded.scope, home_id = excluded.home_id, key = excluded.key,
          list_id = excluded.list_id, list_name = excluded.list_name$$,
  'Alice can remember a list in Personal space (the app''s upsert)'
);
select tests.assert_allowed(
  $$insert into public.ora_memories (scope, home_id, key, list_id, list_name)
    values ((select id::text from ids where name = 'home-b'),
            (select id from ids where name = 'home-b'), 'shopping-list', gen_random_uuid(), 'Weekly')
    on conflict (user_id, scope, key) do update
      set scope = excluded.scope, home_id = excluded.home_id, key = excluded.key,
          list_id = excluded.list_id, list_name = excluded.list_name$$,
  'Alice can remember one in a Home she belongs to'
);
select tests.assert_row_count('select * from public.ora_memories', 2, 'Alice reads her two memories');
select tests.assert_denied(
  $$insert into public.ora_memories (scope, key, list_id, list_name)
    values ('personal', 'free-text', gen_random_uuid(), 'x')$$,
  'Only the closed set of keys is allowed', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_memories (scope, key, list_id, list_name)
    values ((select id::text from ids where name = 'home-b'), 'task-list', gen_random_uuid(), 'x')$$,
  'A Home scope without its Home is refused', '23514'
);
select tests.assert_denied(
  $$update public.ora_memories set scope = 'personal', home_id = null
    where scope = (select id::text from ids where name = 'home-b')$$,
  'A memory cannot be moved to another place'
);
select tests.assert_denied(
  $$insert into public.ora_memories (user_id, scope, key, list_id, list_name)
    values (tests.user_id('bob'), 'personal', 'task-list', gen_random_uuid(), 'x')$$,
  'Alice cannot remember something for Bob'
);
select tests.act_as('carol');
select tests.assert_denied(
  $$insert into public.ora_memories (scope, home_id, key, list_id, list_name)
    values ((select id::text from ids where name = 'home-b'),
            (select id from ids where name = 'home-b'), 'task-list', gen_random_uuid(), 'x')$$,
  'Carol cannot remember a list in a Home she does not belong to'
);
select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_memories', 0,
  'Bob cannot read Alice''s memories, an Owner of that Home included');
select tests.assert_row_count($$delete from public.ora_memories returning key$$, 0,
  'Bob cannot forget Alice''s memories');

select tests.act_as('alice');
select tests.assert_allowed(
  $$delete from public.ora_memories where scope = 'personal' and key = 'task-list'$$,
  'Alice can forget a memory'
);
select tests.assert_row_count('select * from public.ora_memories', 1, 'One memory is left');

-- Leaving a Home deletes its lines and memories ----------------------------------------------------------

select tests.act_as('alice');
insert into public.ora_interactions (scope, home_id, kind, label)
  values ((select id::text from ids where name = 'home-b'),
          (select id from ids where name = 'home-b'), 'task-added', 'In Kot');
select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('alice');
select tests.assert_row_count(
  $$select * from public.ora_memories where home_id = (select id from ids where name = 'home-b')$$,
  0,
  'Leaving a Home deletes the memories there'
);
select tests.assert_row_count(
  $$select * from public.ora_interactions
    where home_id = (select id from ids where name = 'home-b')$$,
  0,
  'Leaving a Home deletes the history lines there'
);
