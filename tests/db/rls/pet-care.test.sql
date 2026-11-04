-- S31 (care part): pet-care schedules (supabase/migrations/*_pet_care.sql). Alice owns Home A, where Bob
-- is an Administrator granted manageHomePets (no medical access) and Carol a Member; Bob owns Home B.
-- Covers: nothing reachable as a table; who may create, change, pause, end and delete activities (pet
-- managers; medical manage too for medical details); one-time and recurring schedules, occurrences up
-- to the horizon and never twice; completion by any member with actor and time, retry, concurrent
-- completion, correction and reopen; skip by the responsible member; "only this occurrence" versus
-- "from this occurrence on"; pause and resume without back-fill; concealment of medical details in
-- pages, the widget and notification names; reminders (queued, rechecked, ids only, responsible members
-- only); the vacation reminder's pet-care counts; trash; departed members; isolation and forged ids.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
insert into ids select 'm-alice-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');
insert into ids select 'm-bob-b', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('bob');

insert into ids select n, gen_random_uuid() from unnest(array[
  'p-rex', 'p-b', 'c-feed', 'c-groom', 'c-med', 'c-bad', 'c-b', 'c-gap'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.d(p_days integer) returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date + p_days; $$;
create function tests.arev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.pet_care_activities where id = tests.i(p_name); $$;
-- The occurrence of an activity on a date (by its scheduled date), as a uuid.
create function tests.occ(p_name text, p_days integer) returns uuid
  language sql stable security definer as $$
  select id from private.pet_care_occurrences where activity_id = tests.i(p_name) and scheduled_on = tests.d(p_days); $$;
create function tests.orev(p_occ uuid) returns integer
  language sql stable security definer as $$ select revision from private.pet_care_occurrences where id = p_occ; $$;
create function tests.ocount(p_name text) returns bigint
  language sql stable security definer as $$
  select count(*) from private.pet_care_occurrences where activity_id = tests.i(p_name); $$;
create function tests.create_care(p_id text, p_pet text, p_activity jsonb, p_schedule jsonb) returns text
  language sql as $$ select public.create_pet_care(tests.i(p_id), tests.i(p_pet), p_activity, p_schedule) ->> 'outcome'; $$;
create function tests.care(p_name text) returns jsonb
  language plpgsql as $$ begin return public.get_pet_care_activity(tests.i(p_name)); end $$;
create function tests.widget(p_who text) returns jsonb
  language plpgsql as $$ begin return public.list_home_pet_care(tests.i('home-a'), null, 7, p_who, 15); end $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications n join auth.users u on u.id = n.user_id
  where u.email = p_user || '@madeora.test' and n.kind = p_kind; $$;
create function tests.jobs(p_occ uuid) returns bigint
  language sql stable security definer as $$
  select count(*) from private.job_outbox where job_name = 'pet-care-reminder' and payload ->> 'occurrenceId' = p_occ::text; $$;
create function tests.reminder_at(p_occ uuid) returns timestamptz
  language sql stable security definer as $$
  select private.pet_care_reminder_at(o, a) from private.pet_care_occurrences o
  join private.pet_care_activities a on a.id = o.activity_id where o.id = p_occ; $$;
create function tests.audit_has_text(p_text text) returns boolean
  language sql stable security definer as $$
  select exists (select 1 from private.audit_events e where e.subject_type like 'pet_care%' and e.details::text like '%' || p_text || '%'); $$;
grant execute on function tests.i(text), tests.d(integer), tests.arev(text), tests.occ(text, integer),
  tests.orev(uuid), tests.ocount(text), tests.create_care(text, text, jsonb, jsonb), tests.care(text),
  tests.widget(text), tests.notices(text, text), tests.jobs(uuid), tests.reminder_at(uuid), tests.audit_has_text(text)
  to authenticated, service_role;

-- Nothing is reachable as a table ---------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.pet_care_activities', 'The API cannot read care activities');
select tests.assert_denied('select * from private.pet_care_occurrences', 'Nor occurrences');
select tests.assert_denied('select * from private.pet_care_events', 'Nor their history');
select tests.assert_denied($$select private.pet_care_limit('title')$$, 'Nor the helpers');
select tests.assert_denied($$select public.deliver_pet_care_reminder(gen_random_uuid(), now())$$,
  'People cannot deliver reminders');
select tests.assert_denied($$select public.advance_all_pet_care(10)$$, 'Nor run the hourly advance');
select tests.act_as_anon();
select tests.assert_denied($$select public.get_pet_care(gen_random_uuid())$$, 'Nobody signed out reads care');

-- Setup: a pet in each Home ------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_pet(tests.i('p-rex'), tests.i('home-a'), 'Rex');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomePets']);
select tests.act_as('bob');
select public.create_pet(tests.i('p-b'), tests.i('home-b'), 'Kat');

-- Creating, and who may ----------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.create_care('c-bad', 'p-rex', '{"title": "Walk"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(1))) = 'not_permitted', 'A member adds no care');
select tests.assert_true(tests.create_care('c-bad', 'p-b', '{"title": "Walk"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(1))) = 'not_found', 'Nor for a pet of another Home');
select tests.act_as('bob');
select tests.assert_true(tests.create_care('c-bad', 'p-rex', '{"title": "Pill", "category": "medication"}',
  jsonb_build_object('frequency', 'daily', 'startsOn', tests.d(0))) = 'not_permitted',
  'A pet manager without medical manage adds no medication');
select tests.assert_true(tests.create_care('c-bad', 'p-rex', '{"title": "Pill", "medical": true}',
  jsonb_build_object('frequency', 'daily', 'startsOn', tests.d(0))) = 'not_permitted',
  'Nor anything with medical details');
select tests.assert_true(tests.create_care('c-bad', 'p-rex', '{"title": "Walk"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(1), 'members', array[tests.i('m-bob-b')])) = 'invalid_member',
  'Responsible members are members of the pet''s Home');
select tests.assert_true(tests.create_care('c-bad', 'p-rex', '{"title": "Walk"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(-400))) = 'invalid_dates', 'A start long past is refused');
select tests.assert_denied($$select tests.create_care('c-bad', 'p-rex', '{"title": "  "}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(1)))$$, 'A blank title is refused', '22023');
select tests.assert_denied($$select tests.create_care('c-bad', 'p-rex', '{"title": "Walk"}',
  jsonb_build_object('frequency', 'weekly', 'startsOn', tests.d(1)))$$, 'A weekly schedule needs weekdays', '22023');
select tests.assert_denied($$select tests.create_care('c-bad', 'p-rex', '{"title": "Walk"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(1), 'time', '25:00'))$$, 'A time must exist', '22023');
select tests.assert_true(not exists (select 1 from public.get_pet_care(tests.i('p-rex')) x
  where jsonb_array_length(x -> 'activities') > 0), 'Nothing was saved');

-- A one-time, unassigned grooming by the pet manager, a daily feeding for Carol at 07:30, medication by
-- the Owner (medical manage).
select tests.assert_true(tests.create_care('c-groom', 'p-rex', '{"title": "Brush coat", "category": "grooming"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(2))) = 'created', 'A pet manager adds one-time grooming');
select tests.assert_true(tests.create_care('c-groom', 'p-rex', '{"title": "Brush coat", "category": "grooming"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(2))) = 'exists', 'A retry answers exists');
select tests.act_as('alice');
select tests.assert_true(tests.create_care('c-groom', 'p-rex', '{"title": "x"}',
  jsonb_build_object('frequency', 'once', 'startsOn', tests.d(2))) = 'id_taken', 'Someone else''s id is taken');
select tests.assert_true(tests.create_care('c-feed', 'p-rex',
  '{"title": "Breakfast", "category": "feeding", "instructions": "Half a cup", "reminder": 15}',
  jsonb_build_object('frequency', 'daily', 'startsOn', tests.d(-2), 'time', '07:30',
    'members', array[tests.i('m-carol-a')])) = 'created', 'The Owner adds daily feeding for Carol');
select tests.assert_true(tests.create_care('c-med', 'p-rex',
  '{"title": "Thyroxine 0.2 mg", "category": "medication", "instructions": "With food", "medical": false}',
  jsonb_build_object('frequency', 'weekly', 'weekdays', array[1, 4], 'startsOn', tests.d(0),
    'members', array[tests.i('m-carol-a'), tests.i('m-bob-a')])) = 'created', 'And medication');
select tests.assert_true((tests.care('c-med') ->> 'medical')::boolean, 'Medication always has medical details');

-- Occurrences: up to seven days ahead, never twice, missed ones overdue ---------------------------------

select tests.assert_true(tests.ocount('c-groom') = 1, 'A one-time activity has one occurrence');
select tests.assert_true(tests.ocount('c-feed') = 10, 'Daily feeding: two days back, today and seven ahead');
select public.get_pet_care(tests.i('p-rex'));
select public.list_home_pet_care(tests.i('home-a'), null, 7, 'all', 15);
select tests.assert_true(tests.ocount('c-feed') = 10, 'Reading again creates nothing twice');
select tests.assert_true(
  (select x ->> 'status' from jsonb_array_elements(tests.care('c-feed') -> 'open') x
    where x ->> 'scheduledOn' = tests.d(-1)::text) = 'overdue', 'A missed day is overdue');
select tests.assert_true(
  (select x ->> 'status' from jsonb_array_elements(tests.care('c-feed') -> 'open') x
    where x ->> 'scheduledOn' = tests.d(1)::text) = 'upcoming', 'Tomorrow is upcoming');
select tests.assert_true(
  (select x -> 'members' from jsonb_array_elements(tests.care('c-feed') -> 'open') x
    where x ->> 'scheduledOn' = tests.d(1)::text) = jsonb_build_array(tests.i('m-carol-a')),
  'With its responsible member');
select tests.assert_true(
  (select x -> 'members' from jsonb_array_elements(tests.care('c-groom') -> 'open') x) = '[]'::jsonb,
  'Unassigned care has nobody');

-- Concealment ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((tests.care('c-med') ->> 'concealed')::boolean
  and tests.care('c-med') -> 'title' = 'null'::jsonb and tests.care('c-med') -> 'instructions' = 'null'::jsonb
  and tests.care('c-med') ->> 'category' = 'medication',
  'A member without medical view sees medication as its category only');
select tests.assert_true(position('Thyroxine' in public.get_pet_care(tests.i('p-rex'))::text) = 0
  and position('With food' in public.get_pet_care(tests.i('p-rex'))::text) = 0, 'Not in the pet''s care list');
select tests.assert_true(position('Thyroxine' in tests.widget('all')::text) = 0
  and position('Breakfast' in tests.widget('all')::text) > 0, 'Nor in the widget, which shows other care');
select tests.assert_true(tests.care('c-feed') ->> 'title' = 'Breakfast', 'Ordinary care is shown in full');
select tests.act_as('bob');
select tests.assert_true((tests.care('c-med') ->> 'concealed')::boolean and not (tests.care('c-med') ->> 'canEdit')::boolean,
  'A pet manager without medical view sees it concealed and cannot edit it');
select tests.assert_true((select public.update_pet_care(tests.i('c-med'), tests.arev('c-med'),
  '{"title": "Guess"}') ->> 'outcome') = 'not_permitted', 'Nor change it');
select tests.assert_true((select public.delete_pet_care(tests.i('c-med'), tests.arev('c-med')) ->> 'outcome') = 'not_permitted',
  'Nor delete it');
select tests.act_as('alice');
select public.set_pet_medical_access(tests.i('home-a'), tests.i('m-carol-a'), 'view');
select tests.act_as('carol');
select tests.assert_true(tests.care('c-med') ->> 'title' = 'Thyroxine 0.2 mg', 'Medical view shows it at once');
select tests.act_as('alice');
select public.set_pet_medical_access(tests.i('home-a'), tests.i('m-carol-a'), 'none');
select tests.act_as('carol');
select tests.assert_true(tests.care('c-med') -> 'title' = 'null'::jsonb, 'And revoking hides it on the next read');

-- The widget's filters ---------------------------------------------------------------------------------

select tests.assert_true((select bool_and(x -> 'members' @> jsonb_build_array(tests.i('m-carol-a')))
  from jsonb_array_elements(tests.widget('me') -> 'rows') x), 'Me: only care Carol is responsible for');
select tests.assert_true((select bool_and(x -> 'members' = '[]'::jsonb)
  from jsonb_array_elements(tests.widget('unassigned') -> 'rows') x)
  and jsonb_array_length(tests.widget('unassigned') -> 'rows') = 1, 'Unassigned: the grooming');
select tests.assert_true((public.list_home_pet_care(tests.i('home-a'), null, 1, 'all', 2) ->> 'hasMore')::boolean
  and jsonb_array_length(public.list_home_pet_care(tests.i('home-a'), null, 1, 'all', 2) -> 'rows') = 2,
  'The count limits the rows');
select tests.assert_true(jsonb_array_length(public.list_home_pet_care(tests.i('home-a'), tests.i('p-b'), 7, 'all', 15) -> 'rows') = 0,
  'A pet of another Home shows nothing');
select tests.assert_denied($$select public.list_home_pet_care(tests.i('home-b'), null, 7, 'all', 15)$$,
  'Another Home''s widget is refused');

-- Completing, correcting, reopening, skipping --------------------------------------------------------------

select tests.act_as_owner();
insert into ids values ('o-y', tests.occ('c-feed', -1)), ('o-t', tests.occ('c-feed', 0)), ('o-n', tests.occ('c-feed', 1)),
  ('o-g', tests.occ('c-groom', 2)), ('o-m', (select id from private.pet_care_occurrences
    where activity_id = (select id from ids where name = 'c-med') order by scheduled_on limit 1));
select tests.act_as('carol');
select tests.assert_true((public.complete_pet_care_occurrence(tests.i('o-y'), tests.orev(tests.i('o-y')),
  now() - interval '1 hour', 'Ate it all') ->> 'outcome') = 'completed', 'A member completes care');
select tests.assert_true((public.complete_pet_care_occurrence(tests.i('o-y'), 1, null, null) ->> 'outcome') = 'completed',
  'A retry by the same person answers completed');
select tests.assert_true((tests.care('c-feed') -> 'recent' -> 0 ->> 'completedBy')::uuid = tests.i('m-carol-a')
  and tests.care('c-feed') -> 'recent' -> 0 ->> 'status' = 'completed', 'With who recorded it');
select tests.assert_true((public.complete_pet_care_occurrence(tests.i('o-g'), tests.orev(tests.i('o-g'))) ->> 'outcome') = 'completed',
  'Anyone completes unassigned care');
select tests.assert_true((public.complete_pet_care_occurrence(tests.i('o-m'), tests.orev(tests.i('o-m')), null,
  'Gave half') ->> 'outcome') = 'completed', 'And concealed care');
select tests.assert_true((public.correct_pet_care_completion(tests.i('o-m'), tests.orev(tests.i('o-m')), now(), 'x')
  ->> 'outcome') = 'not_permitted', 'But cannot correct a note she may not see');
select tests.assert_denied($$select public.complete_pet_care_occurrence(tests.i('o-t'), 1, now() + interval '1 day')$$,
  'A completion in the future is refused', '22023');
select tests.act_as('bob');
select tests.assert_true((public.complete_pet_care_occurrence(tests.i('o-y'), 1) ->> 'outcome') = 'closed',
  'A second person finds it already done');
select tests.assert_true((public.correct_pet_care_completion(tests.i('o-y'), tests.orev(tests.i('o-y')),
  now() - interval '3 hours', 'Ate half') ->> 'outcome') = 'saved', 'A pet manager corrects the time and note');
select tests.assert_true((tests.care('c-feed') -> 'recent' -> 0 ->> 'corrected')::boolean, 'The correction shows');
select tests.act_as_owner();
select tests.assert_true((select count(*) from private.pet_care_events where occurrence_id = tests.i('o-y')) = 2,
  'The history keeps both');
select tests.act_as('bob');
select tests.act_as('carol');
select tests.assert_true((public.reopen_pet_care_occurrence(tests.i('o-g'), tests.orev(tests.i('o-g'))) ->> 'outcome') = 'reopened',
  'Who recorded it reopens it');
select tests.assert_true((public.skip_pet_care_occurrence(tests.i('o-g'), tests.orev(tests.i('o-g'))) ->> 'outcome') = 'not_permitted',
  'Only responsible members and managers skip');
select tests.assert_true((public.skip_pet_care_occurrence(tests.i('o-t'), tests.orev(tests.i('o-t'))) ->> 'outcome') = 'skipped',
  'Carol skips her own');
select tests.assert_true((public.reopen_pet_care_occurrence(tests.i('o-y'), tests.orev(tests.i('o-y'))) ->> 'outcome') = 'reopened',
  'And reopens one she recorded');
select tests.assert_true((public.complete_pet_care_occurrence(tests.i('o-y'), tests.orev(tests.i('o-y'))) ->> 'outcome') = 'completed',
  'Completes it again');
select tests.act_as('bob');
select tests.assert_true((public.complete_pet_care_occurrence(tests.i('o-n'), 99) ->> 'outcome') = 'stale', 'Stale revision');
select tests.act_as_owner();
select tests.assert_true(not tests.audit_has_text('Ate') and not tests.audit_has_text('Thyroxine')
  and not tests.audit_has_text('Breakfast'), 'Audit events carry no titles or notes');

-- Only this occurrence, and from this occurrence on --------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true((public.update_pet_care_occurrence(tests.i('o-n'), tests.orev(tests.i('o-n')), tests.d(1), '09:00',
  array[tests.i('m-bob-a')]) ->> 'outcome') = 'saved', 'A pet manager moves one occurrence and reassigns it');
select tests.assert_true((public.update_pet_care_occurrence(tests.i('o-n'), tests.orev(tests.i('o-n')), tests.d(1), '09:00',
  array[tests.i('m-bob-b')]) ->> 'outcome') = 'invalid_member', 'Only to members of the Home');
select tests.act_as('carol');
select tests.assert_true((public.update_pet_care_occurrence(tests.i('o-n'), tests.orev(tests.i('o-n')), tests.d(1), '10:00',
  '{}') ->> 'outcome') = 'not_permitted', 'A member does not');
select tests.act_as('alice');
select tests.assert_true((public.update_pet_care(tests.i('c-feed'), tests.arev('c-feed'),
  '{"title": "Breakfast", "category": "feeding", "reminder": 15}',
  jsonb_build_object('frequency', 'daily', 'interval', 2, 'startsOn', tests.d(3), 'time', '08:00',
    'members', '[]'::jsonb), tests.d(3)) ->> 'outcome') = 'saved', 'From day 3 on: every other day, unassigned');
select tests.act_as_owner();
select tests.assert_true((select at_time from private.pet_care_occurrences where id = tests.i('o-n')) = '09:00'
  and exists (select 1 from private.pet_care_occurrences where id = tests.i('o-n')),
  'The occurrence changed on its own keeps its change');
select tests.assert_true(tests.occ('c-feed', 2) is not null and tests.occ('c-feed', 4) is null
  and tests.occ('c-feed', 5) is not null, 'Earlier days stay; the new rule applies from day 3');
select tests.assert_true((select count(*) from private.pet_care_occurrence_members m
  where m.occurrence_id = tests.occ('c-feed', 5)) = 0, 'Unassigned from then on');
select tests.assert_true((select status from private.pet_care_occurrences where id = tests.i('o-y')) = 'completed',
  'Completed care stays');
select tests.act_as('alice');

-- Pause, resume, end -------------------------------------------------------------------------------------

select tests.assert_true((public.set_pet_care_state(tests.i('c-feed'), tests.arev('c-feed'), 'paused') ->> 'outcome') = 'saved',
  'Paused');
select tests.assert_true(tests.occ('c-feed', 5) is null and tests.occ('c-feed', 1) is not null,
  'Future untouched occurrences go; the one changed on its own stays');
select tests.assert_true((select x ->> 'status' from jsonb_array_elements(tests.care('c-feed') -> 'open') x
  where x ->> 'id' = tests.i('o-n')::text) = 'paused', 'And shows as paused');
select tests.assert_true(position(tests.i('o-n')::text in tests.widget('all')::text) = 0, 'Paused care leaves the widget');
select public.get_pet_care(tests.i('p-rex'));
select tests.assert_true(tests.occ('c-feed', 5) is null, 'Nothing is created while paused');
select tests.assert_true((public.set_pet_care_state(tests.i('c-feed'), tests.arev('c-feed'), 'paused') ->> 'outcome') = 'invalid_state',
  'Pausing twice is refused');
select tests.assert_true((public.set_pet_care_state(tests.i('c-feed'), tests.arev('c-feed'), 'active') ->> 'outcome') = 'saved',
  'Resumed');
select tests.assert_true(tests.occ('c-feed', 5) is not null, 'Care continues');
select tests.assert_true((public.set_pet_care_state(tests.i('c-groom'), tests.arev('c-groom'), 'ended') ->> 'outcome') = 'saved',
  'Ended');
select tests.assert_true((public.set_pet_care_state(tests.i('c-groom'), tests.arev('c-groom'), 'active') ->> 'outcome') = 'invalid_state',
  'An ended activity stays ended');
select tests.act_as('carol');
select tests.assert_true((public.set_pet_care_state(tests.i('c-feed'), tests.arev('c-feed'), 'paused') ->> 'outcome') = 'not_permitted',
  'A member does not pause care');

-- Reminders ----------------------------------------------------------------------------------------------

select tests.act_as_owner();
-- Today's Breakfast was skipped; tomorrow's (moved, Bob's) gets a reminder 15 minutes before 09:00.
select tests.assert_true(tests.jobs(tests.i('o-n')) >= 1, 'A reminder is queued for responsible members');
select tests.assert_true(tests.jobs(tests.occ('c-feed', 5)) = 0, 'Unassigned care gets none');
-- A moment that moved without a change queuing it (a Home timezone change) is queued again at delivery.
update private.pet_care_occurrences set at_time = '11:00' where id = tests.i('o-n');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_pet_care_reminder(tests.i('o-n'),
  ((tests.d(1) + time '09:00') at time zone 'Europe/Brussels') - interval '15 minutes') = 'stale',
  'The old moment is stale');
select tests.act_as_owner();
select tests.assert_true(exists (select 1 from private.job_outbox where job_name = 'pet-care-reminder'
  and payload ->> 'occurrenceId' = tests.i('o-n')::text
  and (payload ->> 'at')::timestamptz = tests.reminder_at(tests.i('o-n'))), 'And the new moment is queued');
-- Make its moment five minutes ago.
update private.pet_care_occurrences set due_on = (now() at time zone 'Europe/Brussels')::date,
  at_time = date_trunc('minute', (now() at time zone 'Europe/Brussels')::time + interval '10 minutes')
  where id = tests.i('o-n');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_pet_care_reminder(tests.i('o-n'), now() - interval '1 hour') = 'stale',
  'Another moment is stale');
select tests.assert_true(public.deliver_pet_care_reminder(tests.i('o-n'), tests.reminder_at(tests.i('o-n'))) = 'notified',
  'The current moment notifies');
select tests.assert_true(public.deliver_pet_care_reminder(tests.i('o-n'), tests.reminder_at(tests.i('o-n'))) = 'notified',
  'A duplicate run');
select tests.assert_true(tests.notices('bob', 'pet_care.reminder') = 1 and tests.notices('carol', 'pet_care.reminder') = 0,
  'Only the responsible member, once');
select tests.assert_true((select bool_and(position('Breakfast' in n.params::text) = 0) from public.notifications n
  where n.kind = 'pet_care.reminder'), 'The notice carries ids only');
select tests.act_as_owner();
update private.pet_care_occurrences set status = 'skipped', skipped_at = now(), skipped_by = tests.user_id('bob')
  where id = tests.i('o-n');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_pet_care_reminder(tests.i('o-n'), tests.reminder_at(tests.i('o-n'))) = 'inactive',
  'Closed care is not reminded');

-- Notification names ------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((select title is null and category = 'medication' and pet_name = 'Rex'
  from public.pet_care_notice_names(array[tests.i('o-m')])), 'Names are concealed for medication');
select tests.assert_true((select title = 'Breakfast' from public.pet_care_notice_names(array[tests.i('o-y')])),
  'And shown for ordinary care');
select tests.act_as('bob');
select tests.assert_true((select count(*) from public.pet_care_notice_names(array[tests.i('o-m')])) = 1, 'Bob in Home A sees it');

-- The vacation reminder counts pet care ------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true((select activities = 2 and unassigned = 1
  from private.vacation_pet_care(tests.i('home-a'), tests.d(10), tests.d(20))),
  'Two activities continue during a vacation, one of them unassigned');

-- Trash ---------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true((public.delete_pet_care(tests.i('c-feed'), tests.arev('c-feed')) ->> 'outcome') = 'deleted',
  'A pet manager deletes care');
select tests.assert_true(tests.care('c-feed') is null and position(tests.i('o-y')::text in tests.widget('all')::text) = 0,
  'It is gone from pages and the widget');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'), 'pets', 'pet_care_activity')) = 1,
  'It is in the trash');
select tests.act_as('carol');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'), 'pets', 'pet_care_activity')) = 0,
  'Members do not see it there');
select tests.act_as('alice');
select tests.assert_true((public.delete_pet_care(tests.i('c-med'), tests.arev('c-med')) ->> 'outcome') = 'deleted',
  'The Owner deletes medication care');
select tests.act_as('bob');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'), 'pets', 'pet_care_activity')) = 1,
  'Its trash entry is hidden from a pet manager without medical manage');
select tests.assert_true((select outcome from public.restore_trash_entries(array[(select entry_id
  from public.list_trash(tests.i('home-a'), 'pets', 'pet_care_activity'))])) = 'restored', 'He restores the feeding');
select tests.assert_true(tests.care('c-feed') is not null, 'Feeding is back');

-- Departed members ---------------------------------------------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships where id = tests.i('m-bob-a');
select tests.assert_true(not exists (select 1 from private.pet_care_occurrence_members where user_id = tests.user_id('bob')
  and home_id = tests.i('home-a')) and not exists (select 1 from private.pet_care_part_members
  where user_id = tests.user_id('bob') and home_id = tests.i('home-a')), 'A departed member is responsible for nothing');
select tests.act_as('bob');
select tests.assert_true(tests.care('c-feed') is null, 'And sees nothing of the Home''s care');
select tests.assert_true((public.complete_pet_care_occurrence(tests.occ('c-feed', 5), 1) ->> 'outcome') = 'not_found',
  'Nor completes it');

-- A schedule change from a date beyond the 7 days ahead leaves no gap -------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.create_care('c-gap', 'p-rex', '{"title": "Water", "category": "feeding"}',
  jsonb_build_object('frequency', 'daily', 'startsOn', tests.d(0))) = 'created', 'Daily care');
select tests.assert_true((public.update_pet_care(tests.i('c-gap'), tests.arev('c-gap'),
  '{"title": "Water", "category": "feeding"}',
  jsonb_build_object('frequency', 'weekly', 'weekdays', '[1, 2, 3, 4, 5, 6, 7]'::jsonb, 'startsOn', tests.d(20)),
  tests.d(20)) ->> 'outcome') = 'saved', 'Changed from day 20 on');
select tests.act_as_owner();
-- Twelve and fourteen days later, as the hourly job would find it.
select private.advance_pet_care_activity(tests.i('c-gap'), tests.d(12));
select tests.assert_true(tests.occ('c-gap', 8) is not null and tests.occ('c-gap', 19) is not null,
  'The old schedule keeps its dates up to the day before the change');
select private.advance_pet_care_activity(tests.i('c-gap'), tests.d(14));
select tests.assert_true((select count(*) from private.pet_care_occurrences
  where activity_id = tests.i('c-gap') and scheduled_on = tests.d(20)) = 1
  and tests.occ('c-gap', 21) is not null, 'The new one takes over from day 20, once');
select tests.assert_true((select activities from private.vacation_pet_care(tests.i('home-a'), tests.d(15), tests.d(16))) >= 1,
  'A vacation during the old schedule''s last days still counts it');

-- Deleting the pet takes its care along ------------------------------------------------------------------

select tests.act_as('alice');
select public.delete_pet(tests.i('p-rex'), (public.get_pet(tests.i('p-rex')) ->> 'revision')::integer);
select tests.assert_true(tests.care('c-feed') is null and jsonb_array_length(tests.widget('all') -> 'rows') = 0,
  'A pet in the trash takes its care out of sight');
select tests.act_as('alice');
select tests.assert_true((select count(*) from public.pet_care_notice_names(array[tests.i('o-y')])) = 0,
  'And out of notification names');

-- Reminder moments across a daylight-saving change (Europe/Brussels: 2027-03-28 02:00 -> 03:00) ----------

select tests.act_as_owner();
update private.pet_care_occurrences set due_on = date '2027-03-29', at_time = '08:00' where id = tests.i('o-y');
update private.pet_care_activities set reminder_minutes = 1440 where id = tests.i('c-feed');
select tests.assert_true(tests.reminder_at(tests.i('o-y')) = timestamptz '2027-03-28 08:00 Europe/Brussels',
  '1 day before is the same wall-clock time the day before, across the change');
update private.pet_care_occurrences set due_on = date '2027-03-28', at_time = null where id = tests.i('o-y');
update private.pet_care_activities set reminder_minutes = 60 where id = tests.i('c-feed');
select tests.assert_true(tests.reminder_at(tests.i('o-y')) = timestamptz '2027-03-28 05:00 UTC',
  'Without a time: 08:00 summer time, one hour before');
