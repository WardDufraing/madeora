-- S22: Home vacations and temporary chore absences (supabase/migrations/*_home_vacations.sql). Alice
-- owns Home A (Europe/Brussels, the only chore manager); Carol, Gus and Dave are Members. Bob owns
-- Home B and is not in Home A.
-- Covers: nothing reachable as a table; create (preview, member for themselves with suggestions,
-- manager for others, validation, retry); statuses; vacation-aware rotation (one away, two
-- overlapping vacations, everyone away, return without catch-up, a protected occurrence, the
-- override warning); the Home-wide pause (confirmation, paused occurrences, new ones created paused,
-- one-off review flag and pool, two overlapping paused vacations, cancel and withdrawal resuming,
-- no growth without confirmation); invitations (notice, no effect while pending, accept, decline,
-- expiry at the start and a stale acceptance, re-invitation); date proposals (accept, decline,
-- supersede, withdraw); withdrawal; shorten; cancel by the sole creator; decisions (keep,
-- reschedule, skip, once); absences (own, private, review, decisions); the reminder (queued,
-- not due, stale, delivered once to managers); departure; cross-Home isolation.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '33000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'gus@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '33000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member'),
  ((select id from ids where name = 'home-a'), '33000000-0000-4000-8000-000000000001', 'member'),
  ((select id from ids where name = 'home-a'), '33000000-0000-4000-8000-000000000002', 'member');
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m
  join auth.users x on x.id = m.user_id, unnest(array['alice', 'carol', 'gus', 'dave']) u
  where m.home_id = (select id from ids where name = 'home-a') and x.email = u || '@madeora.test';
insert into ids select 'm-bob-b', m.id from public.home_memberships m
  where m.home_id = (select id from ids where name = 'home-b') and m.user_id = tests.user_id('bob');
insert into ids select n, gen_random_uuid() from unnest(array[
  'c-rot', 'c-daily', 'c-one', 'c-one2', 'c-one3', 'c-pool', 'v-carol', 'v-gus', 'v-dave', 'v-all', 'v-all2',
  'v-trip', 'v-solo', 'v-b', 'a-carol', 'a-gus', 'c-orph1', 'c-orph2', 'c-orph3', 'v-orph'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.stay(p_member text, p_from integer, p_to integer) returns jsonb
  language sql stable security definer as $$
  select jsonb_build_object('memberId', tests.i('m-' || p_member || '-a'),
    'startsOn', tests.today_a() + p_from, 'endsOn', tests.today_a() + p_to); $$;
-- Creates a recurring chore's occurrence for a date the way advance_chores would on that day.
create function tests.make(p_chore text, p_offset integer) returns uuid
  language plpgsql security definer as $$
  declare
    v_part private.chore_schedules;
  begin
    select * into v_part from private.chore_schedules where chore_id = tests.i(p_chore) and superseded_at is null;
    perform private.create_chore_occurrence(v_part, tests.today_a() + p_offset);
    return (select id from private.chore_occurrences where chore_id = tests.i(p_chore)
      and scheduled_date = tests.today_a() + p_offset);
  end $$;
create function tests.occ(p_chore text, p_offset integer) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore)
    and scheduled_date = tests.today_a() + p_offset; $$;
create function tests.one(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore); $$;
-- An occurrence's assignees by name, comma-separated ('' for nobody), then its status and flags.
create function tests.who(p_occurrence uuid) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(split_part(u.email, '@', 1), ',' order by u.email), '')
  from private.chore_occurrence_assignees a join auth.users u on u.id = a.user_id
  where a.occurrence_id = p_occurrence; $$;
create function tests.state(p_occurrence uuid) returns text
  language sql stable security definer as $$
  select o.status || ':' || coalesce(o.vacation_state, '-') || ':' || o.needs_reassignment::text
    || ':' || o.vacation_review::text
  from private.chore_occurrences o where o.id = p_occurrence; $$;
create function tests.rev(p_occurrence uuid) returns integer
  language sql stable security definer as $$ select revision from private.chore_occurrences where id = p_occurrence; $$;
create function tests.vrev(p_vacation text) returns integer
  language sql stable security definer as $$ select revision from private.home_vacations where id = tests.i(p_vacation); $$;
create function tests.part(p_vacation text, p_user text) returns uuid
  language sql stable security definer as $$
  select p.id from private.home_vacation_participants p join auth.users u on u.id = p.user_id
  where p.vacation_id = tests.i(p_vacation) and u.email = p_user || '@madeora.test'
  order by p.status not in ('pending', 'accepted'), p.created_at desc, p.id limit 1; $$;
create function tests.prev(p_participant uuid) returns integer
  language sql stable security definer as $$ select revision from private.home_vacation_participants where id = p_participant; $$;
create function tests.pstatus(p_participant uuid) returns text
  language sql stable security definer as $$ select status from private.home_vacation_participants where id = p_participant; $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications n join auth.users u on u.id = n.user_id
  where u.email = p_user || '@madeora.test' and n.kind = p_kind; $$;
create function tests.vrow(p_vacation text) returns private.home_vacations
  language sql stable security definer as $$ select * from private.home_vacations where id = tests.i(p_vacation); $$;
create function tests.sd(p_query text) returns boolean
  language plpgsql security definer as $$
  declare
    v_result boolean;
  begin
    execute 'select (' || p_query || ')' into v_result;
    return v_result;
  end $$;
create function tests.prow(p_participant uuid) returns private.home_vacation_participants
  language sql stable security definer as $$ select * from private.home_vacation_participants where id = p_participant; $$;
create function tests.proposals(p_participant uuid) returns text
  language sql stable security definer as $$
  select string_agg(status, ',' order by status) from private.home_vacation_date_proposals
  where participant_id = p_participant; $$;
create function tests.pending_proposal(p_participant uuid) returns uuid
  language sql stable security definer as $$
  select id from private.home_vacation_date_proposals where participant_id = p_participant and status = 'pending'; $$;
create function tests.arev(p_absence text) returns integer
  language sql stable security definer as $$ select revision from private.chore_absences where id = tests.i(p_absence); $$;
create function tests.orow(p_occurrence uuid) returns private.chore_occurrences
  language sql stable security definer as $$ select * from private.chore_occurrences where id = p_occurrence; $$;
create function tests.srev(p_chore text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_schedules where chore_id = tests.i(p_chore) and superseded_at is null; $$;
-- The live occurrence of a chore on a day: its status, or 'none'.
create function tests.on_day(p_chore text, p_offset integer) returns text
  language sql stable security definer as $$
  select coalesce((select status from private.chore_occurrences where chore_id = tests.i(p_chore)
    and scheduled_date = tests.today_a() + p_offset and deleted_at is null), 'none'); $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable ----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.home_vacations', 'The API cannot read vacations');
select tests.assert_denied('select * from private.home_vacation_participants', 'Nor participants');
select tests.assert_denied('select * from private.chore_absences', 'Nor absences');
select tests.assert_denied('select * from private.chore_vacation_decisions', 'Nor decisions');
select tests.assert_denied('select private.reconcile_chore_vacations(gen_random_uuid())',
  'Nor apply the rules directly');
select tests.assert_denied(
  'select public.deliver_vacation_reminder(gen_random_uuid(), current_date, 1)',
  'People cannot deliver reminders');
select tests.act_as_anon();
select tests.assert_denied(format($$select public.list_home_vacations(%L)$$, gen_random_uuid()),
  'Signed-out people read no vacations');

-- Chores ----------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-rot'), tests.i('home-a'), 'Bins',
    jsonb_build_object('mode', 'rotating', 'members', jsonb_build_array(
      tests.i('m-carol-a'), tests.i('m-gus-a'), tests.i('m-dave-a'))),
    p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a() + 1)),
  'A daily rotation Carol, Gus, Dave from tomorrow');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-daily'), tests.i('home-a'), 'Plants',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-gus-a'))),
    p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a() + 1)),
  'A daily chore fixed on Gus');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-one'), tests.i('home-a'), 'Windows',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    p_due_date => tests.today_a() + 9)),
  'A one-off chore for Carol in nine days');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-one2'), tests.i('home-a'), 'Oven',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-dave-a'))),
    p_due_date => tests.today_a() + 9)),
  'Another one-off chore in nine days');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-pool'), tests.i('home-a'), 'Attic',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a() + 9)),
  'An unassigned one-off chore in nine days');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-b'), tests.i('home-b'), null,
    jsonb_build_array(jsonb_build_object('memberId', tests.i('m-bob-b'), 'startsOn', tests.today_a() + 1,
      'endsOn', tests.today_a() + 2)))),
  'Bob has a vacation in his own Home');

-- The rotation as generated: Carol, Gus, Dave, Carol, Gus, Dave, Carol.
select tests.act_as_owner();
select tests.make('c-rot', d) from generate_series(1, 7) d;
select tests.make('c-daily', d) from generate_series(1, 12) d;
select tests.assert_true(
  (select string_agg(tests.who(tests.occ('c-rot', d)), ' ' order by d) from generate_series(1, 7) d)
    = 'carol gus dave carol gus dave carol',
  'Before any vacation the rotation is Carol, Gus, Dave in turn');

-- Creating -----------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied(
  format($$select * from public.create_home_vacation(%L, %L, null, '[]')$$, tests.i('v-carol'), tests.i('home-a')),
  'At least one participant', '22023');
select tests.assert_denied(
  format($$select * from public.create_home_vacation(%L, %L, %L, %L)$$, tests.i('v-carol'), tests.i('home-a'),
    repeat('x', 81), jsonb_build_array(tests.stay('carol', 2, 4))),
  'A name of at most 80 characters', '22023');
select tests.assert_denied(
  format($$select * from public.create_home_vacation(%L, %L, null, %L)$$, tests.i('v-carol'), tests.i('home-b'),
    jsonb_build_array(tests.stay('carol', 2, 4))),
  'Not in a Home she is not in', '42501');
select tests.assert_true(
  (select outcome = 'invalid_dates' from public.create_home_vacation(tests.i('v-carol'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('carol', -1, 4)))),
  'A stay cannot start in the past');
select tests.assert_true(
  (select outcome = 'invalid_dates' from public.create_home_vacation(tests.i('v-carol'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('carol', 4, 2)))),
  'A stay ends on or after its start');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_home_vacation(tests.i('v-carol'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('gus', 2, 4)))),
  'A member creates a vacation only with themselves in it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_home_vacation(tests.i('v-carol'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('carol', 2, 4)), 3)),
  'Only chore managers set a reminder');
select tests.assert_true(
  (select outcome = 'preview' and jsonb_array_length(impact -> 'changes') = 1
      and impact -> 'changes' -> 0 ->> 'change' = 'substituted'
      and (impact -> 'changes' -> 0 ->> 'date')::date = tests.today_a() + 4
    from public.create_home_vacation(tests.i('v-carol'), tests.i('home-a'), '  My   trip ',
      jsonb_build_array(tests.stay('carol', 2, 4)), p_dry_run => true)),
  'The preview names the one rotation turn that passes to someone else');
select tests.assert_true(tests.who(tests.occ('c-rot', 4)) = 'carol', 'A preview changes nothing');
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-carol'), tests.i('home-a'), '  My   trip ',
    jsonb_build_array(tests.stay('carol', 2, 4)))),
  'Carol records her own trip');
select tests.assert_true(
  (select outcome = 'exists' from public.create_home_vacation(tests.i('v-carol'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('carol', 2, 4)))),
  'A retry answers exists');
select tests.assert_true((tests.vrow('v-carol')).name = 'My trip', 'The name is trimmed and spaces collapsed');

select tests.act_as('gus');
select tests.assert_true(
  (select v ->> 'status' = 'upcoming' and (v ->> 'startsOn')::date = tests.today_a() + 2
      and jsonb_array_length(v -> 'participants') = 1 and v ->> 'name' = 'My trip'
      and v -> 'history' = 'null'::jsonb and not (v -> 'can' ->> 'cancel')::boolean
    from public.get_home_vacation(tests.i('v-carol')) v),
  'Gus sees the upcoming vacation with its name, but not its history, and cannot cancel it');

-- Vacation-aware rotation ----------------------------------------------------------------------------------------

select tests.assert_true(
  (select string_agg(tests.who(tests.occ('c-rot', d)), ' ' order by d) from generate_series(1, 7) d)
    = 'carol gus dave gus gus dave carol',
  'Carol''s turn during her trip passes to the next member in order, Gus; the rest stays');
select tests.assert_true(tests.state(tests.occ('c-rot', 4)) = 'open:substitute:false:false',
  'The occurrence is a vacation substitute');
select tests.assert_true(
  (select (s -> 'substituteFor' ->> 'member')::uuid = tests.i('m-carol-a')
    from public.get_chore_vacation_state(tests.occ('c-rot', 4)) s),
  'The occurrence page names whom Gus substitutes for');

-- Dave protects his turn on day 3 (a manager changed it on its own), then goes away on days 3–5.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.occ('c-rot', 3), tests.rev(tests.occ('c-rot', 3)),
    false, p_assignee_ids => array[tests.i('m-dave-a')])),
  'Alice changes Dave''s day-3 occurrence on its own');
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-dave'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('dave', 3, 5)))),
  'Alice records a stay for Dave on days 3 to 5');
select tests.assert_true(tests.who(tests.occ('c-rot', 3)) = 'dave',
  'A changed occurrence is never reassigned automatically');
select tests.assert_true(
  (select bool_or(e ->> 'occurrenceId' = tests.occ('c-rot', 3)::text and e ->> 'reason' = 'away')
    from jsonb_array_elements((public.list_vacation_review(tests.i('v-dave'))) -> 'items') e),
  'It is listed for review instead');

-- Gus goes away on days 4–5 too: two overlapping vacations.
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-gus'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('gus', 4, 5)))),
  'And for Gus on days 4 and 5');
select tests.assert_true(
  (select string_agg(tests.who(tests.occ('c-rot', d)), ' ' order by d) from generate_series(1, 7) d)
    = 'carol gus dave  carol dave carol',
  'Day 4 (Carol, Gus and Dave away) has nobody available; day 5 (Gus and Dave away) passes on to Carol');
select tests.assert_true(tests.state(tests.occ('c-rot', 4)) = 'open:review:true:false'
    and tests.state(tests.occ('c-rot', 5)) = 'open:substitute:false:false',
  'With nobody available the occurrence waits for an assignment review, flagged and unassigned');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_pool(tests.i('home-a')) p where p.id = tests.occ('c-rot', 4)),
  'It is not in the pool');

-- Dave comes back early (his own stay is days 3–3 now): day 4 goes to Dave, day 5 to Dave.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-dave', 'dave'),
    tests.prev(tests.part('v-dave', 'dave')), 'change_dates', false, tests.today_a() + 3, tests.today_a() + 3)),
  'A chore manager changes the dates of a participant a manager added');
select tests.assert_true(
  (select string_agg(tests.who(tests.occ('c-rot', d)), ' ' order by d) from generate_series(1, 7) d)
    = 'carol gus dave dave dave dave carol',
  'Day 4 and 5 now pass to Dave; day 6 is his own turn; nobody owes a catch-up turn');

-- The override: assigning Gus, away on day 5, needs a confirmation.
select tests.assert_true(
  (select outcome = 'member_away' and (impact -> 'away' ->> 0)::uuid = tests.i('m-gus-a')
    from public.update_chore_occurrence(tests.occ('c-rot', 5), tests.rev(tests.occ('c-rot', 5)), false,
      p_assignee_ids => array[tests.i('m-gus-a')])),
  'Assigning a member who is away answers member_away');
select tests.assert_true(tests.who(tests.occ('c-rot', 5)) = 'dave', 'Nothing changed');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.occ('c-rot', 5), tests.rev(tests.occ('c-rot', 5)), false,
      p_assignee_ids => array[tests.i('m-gus-a')], p_confirm_away => true)),
  'Confirmed, the override is saved');

-- Gus's vacation ends early (shorten to day 4): day 5 stays as overridden.
select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-gus'), tests.vrev('v-gus'), 'shorten', false,
    p_ends_on => tests.today_a() + 4)),
  'Alice shortens Gus''s vacation to day 4');
select tests.assert_true(tests.who(tests.occ('c-rot', 5)) = 'gus', 'The override is never overwritten');
select tests.assert_true(
  (select outcome = 'invalid_dates' from public.update_home_vacation(tests.i('v-gus'), tests.vrev('v-gus'), 'shorten', false,
    p_ends_on => tests.today_a() + 4)),
  'Shortening needs an earlier end');

-- Carol withdraws from her own trip: day 4 returns to the plain rotation (Carol).
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-carol', 'carol'),
    tests.prev(tests.part('v-carol', 'carol')), 'withdraw', false)),
  'Carol withdraws');
select tests.assert_true(tests.who(tests.occ('c-rot', 4)) = 'carol' and tests.state(tests.occ('c-rot', 4)) = 'open:-:false:false',
  'Her turn is hers again');
select tests.assert_true(
  (select v ->> 'status' = 'upcoming' and jsonb_array_length(v -> 'participants') = 0
    from public.get_home_vacation(tests.i('v-carol')) v),
  'The vacation stays, with nobody left');

-- Invitations ---------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'invalid_dates' from public.create_home_vacation(tests.i('v-trip'), tests.i('home-a'), 'School trip',
    jsonb_build_array(tests.stay('carol', 6, 7), tests.stay('gus', 0, 7)))),
  'An invitation needs a start after today');
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-trip'), tests.i('home-a'), 'School trip',
    jsonb_build_array(tests.stay('carol', 6, 7), tests.stay('gus', 6, 6), tests.stay('dave', 6, 7)))),
  'Carol records a trip and suggests Gus and Dave');
select tests.assert_true(tests.pstatus(tests.part('v-trip', 'gus')) = 'pending'
    and tests.pstatus(tests.part('v-trip', 'carol')) = 'accepted',
  'She is in at once; the others are invited');
select tests.assert_true(tests.notices('gus', 'vacation.invited') = 1 and tests.notices('dave', 'vacation.invited') = 1,
  'Each invitee is told once');
select tests.assert_true(tests.who(tests.occ('c-rot', 6)) = 'dave', 'A pending invitation changes nothing');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'accept', false)),
  'Nobody accepts for someone else');
select tests.act_as('dave');
select tests.assert_true(
  (select outcome = 'not_found' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'cancel_invitation', false)),
  'Another invitee learns nothing about Gus''s invitation');
select tests.assert_true(
  (select jsonb_array_length(l -> 'invitations') = 1 from public.list_home_vacations(tests.i('home-a')) l),
  'Dave sees his own invitation');
select tests.assert_true(
  (select outcome = 'preview' and impact -> 'changes' -> 0 ->> 'change' = 'substituted'
    from public.change_vacation_participation(tests.part('v-trip', 'dave'), tests.prev(tests.part('v-trip', 'dave')),
      'accept', true)),
  'Before accepting, Dave sees his turn on day 6 would pass on');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-trip', 'dave'),
    tests.prev(tests.part('v-trip', 'dave')), 'decline', false)),
  'Dave declines');
select tests.assert_true(tests.who(tests.occ('c-rot', 6)) = 'dave', 'Declining changes nothing');

-- Gus's invitation reaches its start: it expires; a late acceptance fails.
select tests.act_as_owner();
update private.home_vacation_participants set starts_on = tests.today_a(), ends_on = tests.today_a()
  where id = tests.part('v-trip', 'gus');
select tests.act_as('gus');
select tests.assert_true(
  (select jsonb_array_length(l -> 'invitations') = 0 from public.list_home_vacations(tests.i('home-a')) l),
  'From its start day the invitation is no longer offered');
select tests.assert_true(
  (select outcome = 'expired' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'accept', false)),
  'Accepting at the start answers expired');
select tests.assert_true(tests.pstatus(tests.part('v-trip', 'gus')) = 'expired', 'It is recorded as expired');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' from public.add_vacation_participants(tests.i('v-trip'), tests.vrev('v-trip'),
    jsonb_build_array(tests.stay('gus', 7, 7)), false)),
  'Carol invites Gus again with a new date');
select tests.assert_true(
  tests.sd(format($$(select count(*) = 2 from private.home_vacation_participants
    where vacation_id = %L and user_id = '33000000-0000-4000-8000-000000000001')$$, tests.i('v-trip'))),
  'A new invitation is a new record; the expired one stays');
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'accept', false)),
  'Gus accepts');
select tests.assert_true(tests.who(tests.occ('c-rot', 7)) = 'dave',
  'Day 7: Carol (away) passes to Gus (away), then Dave');

-- Date proposals ----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'change_dates', false, tests.today_a() + 6, tests.today_a() + 7)),
  'The creator cannot change an invitee''s dates directly');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'propose_dates', false, tests.today_a() + 6, tests.today_a() + 7)),
  'She proposes new dates');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'propose_dates', false, tests.today_a() + 5, tests.today_a() + 7)),
  'And again: the first is superseded');
select tests.assert_true(
  tests.proposals(tests.part('v-trip', 'gus')) = 'pending,superseded'
    and tests.notices('gus', 'vacation.dates_proposed') = 2,
  'One waits; Gus was told about each');
select tests.act_as('dave');
select tests.assert_true(
  (select bool_and(e -> 'proposal' = 'null'::jsonb) from public.get_home_vacation(tests.i('v-trip')) v,
    jsonb_array_elements(v -> 'people') e),
  'Another member does not see the waiting proposal');
select tests.act_as('gus');
select tests.assert_true(
  (select count(*) = 1 from public.get_home_vacation(tests.i('v-trip')) v,
    jsonb_array_elements(v -> 'people') e where e -> 'proposal' <> 'null'::jsonb),
  'Gus, its recipient, does');
select tests.act_as('carol');
select tests.assert_true(
  (select (p.starts_on, p.ends_on) = (tests.today_a() + 7, tests.today_a() + 7)
    from tests.prow(tests.part('v-trip', 'gus')) p),
  'Until he accepts, his own dates stay');
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'saved' from public.answer_vacation_date_proposal(
    tests.pending_proposal(tests.part('v-trip', 'gus')),
    'decline', false)),
  'Gus declines');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-trip', 'gus'),
    tests.prev(tests.part('v-trip', 'gus')), 'propose_dates', false, tests.today_a() + 6, tests.today_a() + 7)),
  'Carol proposes once more');
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'saved' from public.answer_vacation_date_proposal(
    tests.pending_proposal(tests.part('v-trip', 'gus')),
    'accept', false)),
  'Gus accepts');
select tests.assert_true(
  (select (p.starts_on, p.ends_on) = (tests.today_a() + 6, tests.today_a() + 7)
    from tests.prow(tests.part('v-trip', 'gus')) p),
  'His dates changed');
select tests.assert_true(
  (select (v.starts_on, v.ends_on) = (tests.today_a() + 6, tests.today_a() + 7) from tests.vrow('v-trip') v),
  'The envelope follows the accepted dates');

-- The Home-wide pause -------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-all'), tests.i('home-a'), 'Summer',
    jsonb_build_array(tests.stay('alice', 8, 9), tests.stay('carol', 8, 9), tests.stay('gus', 8, 9),
      tests.stay('dave', 8, 9)))),
  'Alice records a vacation for everyone on days 8 and 9');
select tests.assert_true(tests.state(tests.occ('c-daily', 8)) = 'open:-:false:false',
  'Without a confirmed pause, chores continue (Gus keeps his fixed chore, listed for review)');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_home_vacation(tests.i('v-all'), tests.vrev('v-all'), 'pause', false)),
  'Only chore managers confirm a Home-wide pause');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'preview' and impact -> 'pauseDates' = jsonb_build_array(jsonb_build_object(
      'from', tests.today_a() + 8, 'to', tests.today_a() + 9))
    from public.update_home_vacation(tests.i('v-all'), tests.vrev('v-all'), 'pause', true)),
  'The preview shows the paused dates');
select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-all'), tests.vrev('v-all'), 'pause', false)),
  'Alice confirms the pause');
select tests.assert_true(
  tests.state(tests.occ('c-daily', 8)) = 'paused:paused:false:false'
    and tests.state(tests.occ('c-daily', 9)) = 'paused:paused:false:false'
    and tests.state(tests.occ('c-daily', 10)) = 'open:-:false:false',
  'Recurring occurrences on paused dates are paused; the next day is not');
select tests.assert_true(
  tests.state(tests.one('c-one')) = 'open:-:false:true' and tests.state(tests.one('c-pool')) = 'open:-:false:true',
  'One-off chores due on a paused date wait for a vacation review');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_pool(tests.i('home-a')) p where p.id = tests.one('c-pool')),
  'An unassigned one-off chore waiting for review is not in the pool');
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'not_claimable' from public.claim_chore_occurrence(tests.one('c-pool'))),
  'Nor claimable');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.complete_chore_occurrence(tests.occ('c-daily', 8),
    tests.i('m-gus-a'))),
  'A paused occurrence cannot be completed');
select tests.act_as_owner();
select tests.make('c-daily', 13);
select tests.assert_true(tests.state(tests.occ('c-daily', 13)) = 'open:-:false:false', 'Day 13 is not paused');
select tests.act_as('alice');

-- A second whole-Home vacation, days 9–11, overlapping the first.
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-all2'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('alice', 9, 10), tests.stay('carol', 9, 10), tests.stay('gus', 9, 10),
      tests.stay('dave', 9, 10)))),
  'A second vacation for everyone on days 9 and 10');
select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-all2'), tests.vrev('v-all2'), 'pause', false)),
  'Its pause is confirmed too');
select tests.assert_true(tests.state(tests.occ('c-daily', 10)) = 'paused:paused:false:false',
  'Day 10 is paused by the second');

-- Every participant extends to day 11: the pause does not grow without a new confirmation.
select tests.assert_true(
  (select bool_and(x.outcome = 'saved') from (
    select (public.change_vacation_participation(p.id, p.revision, 'change_dates', false,
      tests.today_a() + 9, tests.today_a() + 11)).outcome
    from (select (tests.prow(tests.part('v-all2', u))).* from unnest(array['alice', 'carol', 'gus', 'dave']) u) p
    order by p.id) x),
  'Alice extends every stay to day 11');
select tests.assert_true(tests.state(tests.occ('c-daily', 11)) = 'open:-:false:false',
  'Day 11 is not paused without a confirmation');
select tests.assert_true(
  (select v -> 'homePause' -> 'available' = jsonb_build_array(jsonb_build_object(
      'from', tests.today_a() + 11, 'to', tests.today_a() + 11))
    from public.get_home_vacation(tests.i('v-all2')) v),
  'The vacation offers day 11 for confirmation');

-- Cancelling the first: day 8 resumes, day 9 stays paused by the second.
select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-all'), tests.vrev('v-all'), 'cancel', false)),
  'Alice cancels the first');
select tests.assert_true(tests.state(tests.occ('c-daily', 8)) = 'open:-:false:false'
    and tests.state(tests.occ('c-daily', 9)) = 'paused:paused:false:false',
  'Day 8 resumes; day 9 remains paused by the other vacation');
select tests.assert_true(
  (select outcome = 'cancelled' from public.update_home_vacation(tests.i('v-all'), tests.vrev('v-all'), 'rename', false,
    p_name => 'x')),
  'A cancelled vacation is final');

-- Dave withdraws from the second: not everyone is away any more, so nothing is paused.
select tests.act_as('dave');
select tests.assert_true(
  (select outcome = 'saved' from public.change_vacation_participation(tests.part('v-all2', 'dave'),
    tests.prev(tests.part('v-all2', 'dave')), 'withdraw', false)),
  'Dave withdraws himself');
select tests.assert_true(tests.state(tests.occ('c-daily', 9)) = 'open:-:false:false'
    and tests.state(tests.occ('c-daily', 10)) = 'open:-:false:false',
  'The Home-wide pause ends with the withdrawal');
select tests.assert_true(tests.state(tests.one('c-one')) = 'open:-:false:false',
  'And the one-off chore no longer waits for a vacation review');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.add_vacation_participants(tests.i('v-all2'), tests.vrev('v-all2'),
    jsonb_build_array(tests.stay('dave', 9, 11)), false)),
  'Alice adds Dave back');
select tests.assert_true(tests.state(tests.occ('c-daily', 9)) = 'paused:paused:false:false'
    and tests.state(tests.occ('c-daily', 11)) = 'open:-:false:false',
  'The confirmed dates apply again; day 11 still needs a confirmation');
select tests.act_as_owner();
select tests.make('c-daily', 14);
select tests.act_as('alice');

-- One-off decisions.
select tests.assert_true(
  (select count(*) = 3 from jsonb_array_elements((public.list_vacation_review(tests.i('v-all2'))) -> 'items') e
    where e ->> 'reason' = 'paused_date'),
  'Three one-off chores wait on paused dates');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.decide_chore_vacation_item('vacation', tests.i('v-all2'),
    tests.one('c-one'), tests.rev(tests.one('c-one')), 'keep')),
  'Only chore managers decide');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'decided' from public.decide_chore_vacation_item('vacation', tests.i('v-all2'),
    tests.one('c-one'), tests.rev(tests.one('c-one')), 'keep')),
  'Keep the window cleaning on its date');
select tests.assert_true(tests.state(tests.one('c-one')) = 'open:-:false:false', 'It no longer waits');
select tests.assert_true(
  (select outcome = 'already_decided' from public.decide_chore_vacation_item('vacation', tests.i('v-all2'),
    tests.one('c-one'), tests.rev(tests.one('c-one')), 'skip')),
  'A decision is taken once');
select tests.assert_true(
  (select outcome = 'not_one_off' from public.decide_chore_vacation_item('vacation', tests.i('v-all2'),
    tests.occ('c-daily', 13), tests.rev(tests.occ('c-daily', 13)), 'reschedule', p_due_date => tests.today_a() + 20)),
  'Only one-off chores are rescheduled');
select tests.assert_true(
  (select outcome = 'decided' from public.decide_chore_vacation_item('vacation', tests.i('v-all2'),
    tests.one('c-one2'), tests.rev(tests.one('c-one2')), 'reschedule', p_due_date => tests.today_a() + 15)),
  'Reschedule the oven to day 15');
select tests.assert_true(
  (select o.due_date = tests.today_a() + 15 and not o.vacation_review from tests.orow(tests.one('c-one2')) o),
  'Its due date moved and it no longer waits');
select tests.assert_true(
  (select outcome = 'decided' from public.decide_chore_vacation_item('vacation', tests.i('v-all2'),
    tests.one('c-pool'), tests.rev(tests.one('c-pool')), 'skip')),
  'Skip the attic');
select tests.assert_true(tests.state(tests.one('c-pool')) = 'skipped:-:false:false', 'It is skipped');

-- Reassigning a fixed occurrence of an away member through the review needs the override.
select tests.assert_true(
  (select outcome = 'member_away' from public.decide_chore_vacation_item('vacation', tests.i('v-trip'),
    tests.occ('c-daily', 7), tests.rev(tests.occ('c-daily', 7)), 'reassign', tests.i('m-carol-a'))),
  'Reassigning to Carol, who is away on day 7, needs a confirmation');
select tests.assert_true(
  (select outcome = 'decided' from public.decide_chore_vacation_item('vacation', tests.i('v-trip'),
    tests.occ('c-daily', 7), tests.rev(tests.occ('c-daily', 7)), 'reassign', tests.i('m-dave-a'))),
  'Reassigned to Dave');
select tests.assert_true(tests.who(tests.occ('c-daily', 7)) = 'dave', 'Dave has it');

-- Cancel by the sole creator; name rules ---------------------------------------------------------------------

select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-solo'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('gus', 0, 0), tests.stay('carol', 1, 1)))),
  'Gus starts a stay today and suggests Carol');
select tests.assert_true(
  (select v ->> 'status' = 'active' from public.get_home_vacation(tests.i('v-solo')) v),
  'A vacation starting today is active');
select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-solo'), tests.vrev('v-solo'), 'rename', false,
    p_name => 'Weekend')),
  'The creator renames it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_home_vacation(tests.i('v-solo'), tests.vrev('v-solo'), 'shorten',
    false, p_ends_on => tests.today_a())),
  'Only chore managers shorten');
select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-solo'), tests.vrev('v-solo'), 'cancel', false)),
  'The creator cancels while nobody else is in it');
select tests.assert_true(tests.pstatus(tests.part('v-solo', 'carol')) = 'withdrawn',
  'The pending invitation is withdrawn with it');

-- Absences --------------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.save_chore_absence(tests.i('a-gus'), tests.i('home-a'),
    tests.i('m-gus-a'), tests.today_a() + 1, tests.today_a() + 2)),
  'A member registers only their own absence');
select tests.assert_true(
  (select outcome = 'created' from public.save_chore_absence(tests.i('a-carol'), tests.i('home-a'),
    tests.i('m-carol-a'), tests.today_a() + 1, tests.today_a() + 1, 'Dentist')),
  'Carol registers an absence tomorrow');
select tests.assert_true(tests.who(tests.occ('c-rot', 1)) = 'carol', 'An absence changes nothing on its own');
select tests.assert_true(
  (select jsonb_array_length(r -> 'items') = 1 and r -> 'items' -> 0 ->> 'reason' = 'away'
      and not (r ->> 'canDecide')::boolean
    from public.list_absence_review(tests.i('a-carol')) r),
  'Her review lists her turn tomorrow; she cannot decide');
select tests.act_as('gus');
select tests.assert_true(public.list_absence_review(tests.i('a-carol')) is null, 'Gus cannot see Carol''s absence');
select tests.assert_true(
  (select jsonb_array_length(l -> 'absences') = 0 from public.list_chore_absences(tests.i('home-a')) l),
  'Nor find it in the list');
select tests.assert_true(
  (select s -> 'absent' = '[]'::jsonb from public.get_chore_vacation_state(tests.occ('c-rot', 1)) s),
  'The occurrence page does not reveal it to him');
select tests.assert_true(
  tests.sd(format($q$private.chore_review_entry(%L, 'away', 'vacation', gen_random_uuid(), %L) -> 'away'
    = '[]'::jsonb$q$, tests.occ('c-rot', 1), tests.user_id('gus')))
  and tests.sd(format($q$jsonb_array_length(private.chore_review_entry(%L, 'away', 'vacation',
    gen_random_uuid(), %L) -> 'away') = 1$q$, tests.occ('c-rot', 1), tests.user_id('alice'))),
  'Nor does a vacation review: only Carol and chore managers see her marked away');
select tests.act_as('alice');
select tests.assert_true(
  (select l -> 'absences' -> 0 ->> 'reason' = 'Dentist' and (l -> 'absences' -> 0 ->> 'undecided')::integer = 1
    from public.list_chore_absences(tests.i('home-a')) l),
  'The chore manager sees it with the reason and one undecided occurrence');
select tests.assert_true(
  (select outcome = 'decided' from public.decide_chore_vacation_item('absence', tests.i('a-carol'),
    tests.occ('c-rot', 1), tests.rev(tests.occ('c-rot', 1)), 'reassign', tests.i('m-gus-a'))),
  'Alice reassigns Carol''s turn to Gus');
select tests.assert_true(
  (select (l -> 'absences' -> 0 ->> 'undecided')::integer = 0 from public.list_chore_absences(tests.i('home-a')) l),
  'Nothing is left undecided');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_chore_absence(tests.i('a-carol'),
    tests.arev('a-carol'))),
  'The absence is removed; the decision stays');
select tests.assert_true(tests.who(tests.occ('c-rot', 1)) = 'gus', 'Gus keeps the turn');

-- The pre-vacation reminder ---------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-trip'), tests.vrev('v-trip'), 'reminder', false,
    p_reminder_days => 2)),
  'Alice asks for a reminder two days before the school trip');
select tests.assert_true(
  tests.sd(format($$(select count(*) = 1 from private.job_outbox where job_name = 'vacation-reminder'
    and payload ->> 'vacationId' = %L)$$, tests.i('v-trip'))),
  'The reminder job is queued');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_vacation_reminder(tests.i('v-trip'), tests.today_a() + 6, 2) = 'not_due', 'Early: not due');
select tests.assert_true(
  public.deliver_vacation_reminder(tests.i('v-trip'), tests.today_a() + 5, 2) = 'stale', 'Old dates: stale');
select tests.act_as_owner();
update private.home_vacations set reminder_days = 30 where id = tests.i('v-trip');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_vacation_reminder(tests.i('v-trip'), tests.today_a() + 6, 30) = 'notified', 'Due: delivered');
select tests.assert_true(
  public.deliver_vacation_reminder(tests.i('v-trip'), tests.today_a() + 6, 30) = 'notified', 'A duplicate run');
select tests.assert_true(tests.notices('alice', 'vacation.reminder') = 1 and tests.notices('carol', 'vacation.reminder') = 0,
  'The chore manager is told once; members are not');

-- The stricter pause wins ------------------------------------------------------------------------------------------
-- Occurrences paused by a Home vacation are never reopened on a date their chore no longer has: its
-- own pause covers it, a schedule change dropped it, or "delete following" ended the series there.

select tests.act_as('alice');
select tests.assert_true(
  (select bool_and(x.outcome = 'created') from (
    select (public.create_chore(tests.i(c), tests.i('home-a'), 'Daily ' || c,
      jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-gus-a'))),
      p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a() + 1)).outcome
    from unnest(array['c-orph1', 'c-orph2', 'c-orph3']) c) x),
  'Three daily chores fixed on Gus');
select tests.act_as_owner();
select tests.make(c, d) from unnest(array['c-orph1', 'c-orph2', 'c-orph3']) c, generate_series(29, 32) d;
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_home_vacation(tests.i('v-orph'), tests.i('home-a'), null,
    jsonb_build_array(tests.stay('alice', 30, 31), tests.stay('gus', 30, 31), tests.stay('dave', 30, 31),
      tests.stay('carol', 30, 31)))),
  'Everyone is away on days 30 and 31');
select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-orph'), tests.vrev('v-orph'), 'pause', false)),
  'The Home-wide pause is confirmed');
select tests.assert_true(
  (select bool_and(tests.on_day(c, d) = 'paused')
    from unnest(array['c-orph1', 'c-orph2', 'c-orph3']) c, generate_series(30, 31) d),
  'Days 30 and 31 are paused for all three chores');

-- Chore 1 gets its own pause until day 30; chore 2 is deleted from day 29 on; chore 3 becomes
-- weekly on day 29's weekday from day 29.
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_paused(tests.i('c-orph1'), tests.srev('c-orph1'), true,
    tests.today_a() + 30)),
  'Alice pauses chore 1 until day 30');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_chore_occurrences(tests.occ('c-orph2', 29), 'following',
    tests.rev(tests.occ('c-orph2', 29)), false)),
  'Alice deletes chore 2 from day 29 on');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_series(tests.occ('c-orph3', 29), 'following',
    tests.rev(tests.occ('c-orph3', 29)), tests.srev('c-orph3'), false,
    p_set_schedule => true, p_frequency => 'weekly', p_interval => 1,
    p_weekdays => array[extract(isodow from tests.today_a() + 29)::smallint], p_starts_on => tests.today_a() + 29)),
  'Alice makes chore 3 weekly from day 29');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(
  tests.on_day('c-orph1', 30) = 'none' and tests.on_day('c-orph1', 31) = 'paused'
    and tests.on_day('c-orph2', 30) = 'none' and tests.on_day('c-orph2', 31) = 'none'
    and tests.on_day('c-orph3', 30) = 'none' and tests.on_day('c-orph3', 31) = 'none',
  'Paused occurrences their chore no longer has are removed while the vacation lasts');

select tests.assert_true(
  (select outcome = 'saved' from public.update_home_vacation(tests.i('v-orph'), tests.vrev('v-orph'), 'cancel', false)),
  'Alice cancels the vacation');
select tests.assert_true(
  tests.on_day('c-orph1', 30) = 'none' and tests.on_day('c-orph1', 31) = 'open'
    and tests.on_day('c-orph2', 30) = 'none' and tests.on_day('c-orph2', 31) = 'none'
    and tests.on_day('c-orph3', 30) = 'none' and tests.on_day('c-orph3', 31) = 'none',
  'Cancelling reopens only dates the chores still have: the chore pause and the schedule win');

-- Silent rule ----------------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select count(*) = 0 from public.notifications n where n.home_id = tests.i('home-a')
    and n.kind not in ('vacation.invited', 'vacation.dates_proposed', 'vacation.reminder')
    and n.kind like 'vacation.%'),
  'Vacation changes send no other notices');

-- Departure ----------------------------------------------------------------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.assert_true(tests.pstatus(tests.part('v-trip', 'carol')) = 'withdrawn'
    and (tests.prow(tests.part('v-trip', 'carol'))).ended_reason = 'departure',
  'A departing member''s participation ends, kept in the history');

-- Cross-Home isolation ----------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(public.get_home_vacation(tests.i('v-trip')) is null, 'Bob cannot read Home A''s vacation');
select tests.assert_true(public.list_vacation_review(tests.i('v-trip')) is null, 'Nor its review');
select tests.assert_denied(format($$select public.list_home_vacations(%L)$$, tests.i('home-a')),
  'Nor list Home A''s vacations', '42501');
select tests.assert_denied(format($$select public.get_home_vacation_widget(%L)$$, tests.i('home-a')),
  'Nor read its widget', '42501');
select tests.assert_true(
  (select outcome = 'not_found' from public.change_vacation_participation(tests.part('v-trip', 'gus'), 1, 'remove', false)),
  'Nor change its participants');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_home_vacation(tests.i('v-trip'), 1, 'cancel', false)),
  'Nor cancel it');
select tests.assert_true(
  (select outcome = 'invalid_member' from public.add_vacation_participants(tests.i('v-b'), tests.vrev('v-b'),
    jsonb_build_array(tests.stay('carol', 3, 3)), false)),
  'A member of another Home cannot be added to Bob''s vacation');
select tests.assert_true(
  (select outcome = 'not_found' from public.decide_chore_vacation_item('vacation', tests.i('v-b'),
    tests.occ('c-rot', 2), tests.rev(tests.occ('c-rot', 2)), 'keep')),
  'A decision on another Home''s occurrence is not found');
