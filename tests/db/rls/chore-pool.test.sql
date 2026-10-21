-- S21: the unassigned chore pool, claims and reassignment requests
-- (supabase/migrations/*_chore_pool_claims.sql). Alice owns Home A (Europe/Brussels), where Bob is an
-- Administrator (no chore rights) and Carol a Member; Bob owns Home B, which Carol is not in.
-- Covers: nothing reachable as a table, and the Realtime signal row readable by members only; the
-- pool (week and overdue sections, eligibility, restricted chores, another Home); claiming (first
-- claim wins, a retry, another person's claim, assigned, flagged, pending, completed, cross-Home);
-- Undo and release (rights, manager release, progress cleared, manager-assigned work); claim policies
-- (selected members, none, empty and foreign selections, preview and confirmation); end-of-week
-- expiry (claim after the cutoff, lazy expiry, closed for complete, skip and reopen, overdue policy
-- kept available, week start); automatic release (lazy, the job's function, rework kept, the
-- notice, jobs queued); series edits and manager edits around claims; reassignment requests
-- (request, duplicates, recipients, decline, cancel, accept, manager confirmation, invalidation);
-- departure; audit without titles.
--
-- Time cannot move inside a test, so "days passing" is simulated by moving a chore's dates back as
-- the database owner (tests.pool_shift_back).

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Pacific/Auckland', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m, unnest(array['alice', 'bob', 'carol']) u
  where m.home_id = (select id from ids where name = 'home-a') and m.user_id = tests.user_id(u);
insert into ids select 'm-bob-b', m.id from public.home_memberships m
  where m.home_id = (select id from ids where name = 'home-b') and m.user_id = tests.user_id('bob');
insert into ids select n, gen_random_uuid() from unnest(array[
  'c-pool', 'c-fixed', 'c-sel', 'c-week', 'c-over', 'c-auto', 'c-rec', 'c-b', 'c-req', 'c-dep',
  'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.first_occ(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) order by scheduled_date limit 1; $$;
create function tests.occ_on(p_chore text, p_date date) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) and scheduled_date = p_date; $$;
create function tests.f(p_occurrence uuid, p_field text) returns text
  language sql stable security definer as $$
  select to_jsonb(o) ->> p_field from private.chore_occurrences o where o.id = p_occurrence; $$;
create function tests.step_id(p_occurrence uuid) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrence_steps where occurrence_id = p_occurrence order by position limit 1; $$;
create function tests.progress(p_occurrence uuid) returns bigint
  language sql stable security definer as $$
  select count(*) from private.chore_occurrence_steps where occurrence_id = p_occurrence and checked_at is not null; $$;
create function tests.request_note(p_request text) returns text
  language sql stable security definer as $$
  select note from private.chore_reassignment_requests where id = tests.i(p_request); $$;
create function tests.request_from_by(p_request text) returns text
  language sql stable security definer as $$
  select (select email from auth.users where id = r.from_user) || '/' || (select email from auth.users where id = r.requested_by)
  from private.chore_reassignment_requests r where r.id = tests.i(p_request); $$;
create function tests.release_jobs(p_occurrence uuid, p_claim integer) returns setof timestamptz
  language sql stable security definer as $$
  select available_at from private.job_outbox where job_name = 'chore-claim-release'
    and payload = jsonb_build_object('occurrenceId', p_occurrence, 'claim', p_claim); $$;
create function tests.schedule_rev(p_chore text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_schedules where chore_id = tests.i(p_chore) and superseded_at is null; $$;
create function tests.who(p_occurrence uuid) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(split_part(u.email, '@', 1), ',' order by u.email), '')
  from private.chore_occurrence_assignees a join auth.users u on u.id = a.user_id
  where a.occurrence_id = p_occurrence; $$;
create function tests.events(p_occurrence uuid) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(kind || coalesce(':' || reason, ''), ',' order by id), '')
  from private.chore_occurrence_events where occurrence_id = p_occurrence; $$;
create function tests.chore_rev(p_chore text) returns integer
  language sql stable security definer as $$ select revision from private.chores where id = tests.i(p_chore); $$;
create function tests.req(p_request text) returns text
  language sql stable security definer as $$
  select status || coalesce(':' || invalid_reason, '') from private.chore_reassignment_requests
  where id = tests.i(p_request); $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications where user_id = tests.user_id(p_user) and kind = p_kind; $$;
-- Moves a chore p_days into the past, as if that many days had passed since it was set up.
create function tests.pool_shift_back(p_chore text, p_days integer) returns void
  language sql security definer as $$
  update private.chore_schedules set starts_on = starts_on - p_days, active_from = active_from - p_days,
    ends_on = ends_on - p_days, until_date = until_date - p_days, next_date = next_date - p_days,
    last_date = last_date - p_days, rotation_from = rotation_from - p_days
  where chore_id = tests.i(p_chore);
  update private.chore_occurrences set scheduled_date = scheduled_date - p_days - 100000,
    due_date = due_date - p_days
  where chore_id = tests.i(p_chore);
  update private.chore_occurrences set scheduled_date = scheduled_date + 100000
  where chore_id = tests.i(p_chore);
  $$;
create function tests.week_start(p_convention text, p_date date) returns date
  language sql stable security definer as $$ select private.chore_week_start(p_convention, p_date); $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable ----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.chore_claimants', 'The API cannot read claimants');
select tests.assert_denied('select * from private.home_chore_settings', 'Nor chore settings');
select tests.assert_denied('select * from private.chore_reassignment_requests', 'Nor reassignment requests');
select tests.assert_denied(
  format($$insert into public.chore_pool_signals (home_id) values (%L)$$, tests.i('home-a')),
  'Nobody writes the signal row');
select tests.assert_denied(
  format($$select public.release_overdue_chore_claim(%L, 1)$$, gen_random_uuid()),
  'Only the job releases overdue claims');
select tests.act_as_anon();
select tests.assert_denied($$select * from public.chore_pool_signals$$, 'Signed-out people read no signals');
select tests.assert_denied(
  format($$select * from public.list_chore_pool(%L)$$, gen_random_uuid()), 'Nor the pool');
select tests.act_as('carol');
select tests.assert_denied(
  format($$select * from public.list_chore_pool(%L)$$, tests.i('home-b')),
  'Carol cannot read the pool of a Home she is not in');

-- The pool and claiming ----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-pool'), tests.i('home-a'), 'Windows',
    '{"mode": "none", "members": []}', '[{"label": "Inside", "mandatory": false}]',
    p_minutes => 30, p_due_date => tests.today_a())),
  'The Owner creates an unassigned one-off chore');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-fixed'), tests.i('home-a'), 'Bins',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    p_due_date => tests.today_a())),
  'And one assigned to Carol');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-b'), tests.i('home-b'), 'Kot',
    '{"mode": "none", "members": []}', p_due_date => (now() at time zone 'Pacific/Auckland')::date)),
  'Bob creates an unassigned chore in his own Home');

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 and bool_and(id = tests.first_occ('c-pool') and section = 'week' and eligible
     and not restricted and minutes = 30 and steps_total = 1 and week_start <= today and today < week_start + 7)
   from public.list_chore_pool(tests.i('home-a'))),
  'Carol sees the unassigned chore in this week''s pool, and not the one assigned to her');
select tests.assert_true(
  (select (s ->> 'claimable')::boolean and s ->> 'block' is null and s ->> 'claimMode' = 'all'
   from public.get_chore_claim_state(tests.first_occ('c-pool')) s),
  'Its claim state says she can claim it');
select tests.assert_true(
  (select outcome = 'not_found' from public.claim_chore_occurrence(tests.first_occ('c-b'))),
  'Another Home''s occurrence cannot be claimed (it does not exist for her)');
select tests.assert_true(
  (select outcome = 'assigned' from public.claim_chore_occurrence(tests.first_occ('c-fixed'))),
  'An occurrence assigned by a manager is not claimable');

select tests.assert_true(
  (select outcome = 'claimed' and claimed_by_me and claimant_member = tests.i('m-carol-a')
   from public.claim_chore_occurrence(tests.first_occ('c-pool'))),
  'Carol claims it');
select tests.assert_true(tests.who(tests.first_occ('c-pool')) = 'carol', 'She is its only assignee');
select tests.assert_true(
  tests.f(tests.first_occ('c-pool'), 'claimed_by')::uuid = tests.user_id('carol')
  and tests.f(tests.first_occ('c-pool'), 'claim_count') = '1',
  'The claim is recorded');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-pool'))),
  'A retry of her own claim answers claimed again');
select tests.assert_true(tests.f(tests.first_occ('c-pool'), 'claim_count') = '1', 'Without a second claim');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_pool(tests.i('home-a'))),
  'A claimed occurrence leaves the pool');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'already_claimed' and not claimed_by_me and claimant_member = tests.i('m-carol-a')
   from public.claim_chore_occurrence(tests.first_occ('c-pool'))),
  'Alice is told it is already claimed, and by whom');
select tests.assert_true(tests.events(tests.first_occ('c-pool')) = 'claimed', 'One claim event');

-- Release and Undo ---------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_step(tests.step_id(tests.first_occ('c-pool')), true)),
  'Carol ticks a step of her claimed chore');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.release_chore_occurrence(tests.first_occ('c-pool'))),
  'Bob (no chore rights) cannot release Carol''s claim');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'released' and status = 'open' from public.release_chore_occurrence(tests.first_occ('c-pool'), true)),
  'Carol undoes her claim');
select tests.assert_true(
  tests.who(tests.first_occ('c-pool')) = '' and tests.f(tests.first_occ('c-pool'), 'claimed_by') is null,
  'Nobody is assigned any more');
select tests.assert_true(
  tests.progress(tests.first_occ('c-pool')) = 0,
  'Her checklist progress is not handed to the next claimant');
select tests.assert_true(tests.events(tests.first_occ('c-pool')) = 'claimed,released:undo',
  'The release is a new event; the claim stays in the record');
select tests.assert_true(
  (select outcome = 'not_claimed' from public.release_chore_occurrence(tests.first_occ('c-pool'))),
  'Releasing again changes nothing');
select tests.assert_true(
  (select outcome = 'not_claimed' from public.release_chore_occurrence(tests.first_occ('c-fixed'))),
  'A manager-assigned chore cannot be released by its assignee');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-pool'))),
  'Bob claims it next');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'released' from public.release_chore_occurrence(tests.first_occ('c-pool'))),
  'The Owner (a chore manager) returns Bob''s claim to the pool');
select tests.assert_true(tests.events(tests.first_occ('c-pool')) like '%,released:manager',
  'Recorded as a manager release');
select tests.assert_true(tests.notices('bob', 'chore.claim_released') = 1, 'Bob is told');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-pool'))),
  'Carol claims it again');
select tests.assert_true(
  (select outcome = 'completed' from public.complete_chore_occurrence(tests.first_occ('c-pool'), tests.i('m-carol-a'))),
  'And completes it');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.release_chore_occurrence(tests.first_occ('c-pool'))),
  'A completed chore cannot be released');
select tests.assert_true(
  (select outcome = 'already_completed' from public.claim_chore_occurrence(tests.first_occ('c-pool'))),
  'Nor claimed');

-- Claim policies ----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-sel'), tests.i('home-a'), 'Car wash',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'Another unassigned chore');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_chore_claim_policy(tests.i('c-sel'), tests.chore_rev('c-sel'),
    'none', null, 'overdue', null, false)),
  'A Member cannot change who may claim');
select tests.act_as('alice');
select tests.assert_denied(
  format($$select * from public.set_chore_claim_policy(%L, %s, 'selected', '{}', 'overdue', null, false)$$,
    tests.i('c-sel'), tests.chore_rev('c-sel')),
  'Selected members need at least one member', '22023');
select tests.assert_denied(
  format($$select * from public.set_chore_claim_policy(%L, %s, 'all', null, 'overdue', 721, false)$$,
    tests.i('c-sel'), tests.chore_rev('c-sel')),
  'At most 720 hours', '22023');
select tests.assert_true(
  (select outcome = 'invalid_member' from public.set_chore_claim_policy(tests.i('c-sel'), tests.chore_rev('c-sel'),
    'selected', array[tests.i('m-bob-b')], 'overdue', null, false)),
  'A membership of another Home is refused');
select tests.assert_true(
  (select outcome = 'conflict' from public.set_chore_claim_policy(tests.i('c-sel'), tests.chore_rev('c-sel') - 1,
    'all', null, 'overdue', null, false)),
  'A stale revision is a conflict');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_claim_policy(tests.i('c-sel'), tests.chore_rev('c-sel'),
    'selected', array[tests.i('m-carol-a')], 'overdue', null, false)),
  'The Owner restricts it to Carol');
select tests.assert_true(
  (select p -> 'members' = jsonb_build_array(tests.i('m-carol-a')) and p ->> 'claimMode' = 'selected'
   from public.get_chore_claim_policy(tests.i('c-sel')) p),
  'The editor shows the selected member to a chore manager');
select tests.act_as('bob');
select tests.assert_true(
  (select p -> 'members' = 'null'::jsonb from public.get_chore_claim_policy(tests.i('c-sel')) p),
  'Others never see who may claim');
select tests.assert_true(
  (select restricted and not eligible from public.list_chore_pool(tests.i('home-a')) where chore_id = tests.i('c-sel')),
  'Bob sees it restricted and not eligible');
select tests.assert_true(
  (select outcome = 'not_eligible' from public.claim_chore_occurrence(tests.first_occ('c-sel'))),
  'And cannot claim it');
select tests.act_as('carol');
select tests.assert_true(
  (select restricted and eligible from public.list_chore_pool(tests.i('home-a')) where chore_id = tests.i('c-sel')),
  'Carol is eligible');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-sel'))),
  'And claims it');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'claimedIneligible')::integer = 1
   from public.set_chore_claim_policy(tests.i('c-sel'), tests.chore_rev('c-sel'), 'none', null, 'overdue', null, true)),
  'Closing the chore to claims reports the claim the new rule would not allow');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_claim_policy(tests.i('c-sel'), tests.chore_rev('c-sel'),
    'none', null, 'overdue', null, false)),
  'And saves without a confirmation (nothing changes at once)');
select tests.assert_true(tests.who(tests.first_occ('c-sel')) = 'carol', 'Carol keeps her claim');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'released' from public.release_chore_occurrence(tests.first_occ('c-sel'))),
  'She releases it');
select tests.assert_true(
  (select outcome = 'not_claimable' from public.claim_chore_occurrence(tests.first_occ('c-sel'))),
  'A chore closed to claims is not claimable');
select tests.assert_true(
  not exists (select 1 from public.list_chore_pool(tests.i('home-a')) where chore_id = tests.i('c-sel')),
  'And not in the pool');

-- End-of-week expiry ------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-week'), tests.i('home-a'), 'Garage',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'A chore that will close unclaimed');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_claim_policy(tests.i('c-week'), tests.chore_rev('c-week'),
    'all', null, 'week_end', null, false)),
  'Set to close after its week');
select tests.assert_true(
  (select s ->> 'closesOn' = (tests.week_start('monday', tests.today_a()) + 7)::text
   from public.get_chore_claim_state(tests.first_occ('c-week')) s),
  'It closes on the first day of next week');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-over'), tests.i('home-a'), 'Shed',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'And one that stays available');
select tests.act_as_owner();
select tests.pool_shift_back('c-week', 8);
select tests.pool_shift_back('c-over', 8);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'expired' from public.claim_chore_occurrence(tests.first_occ('c-week'))),
  'Past its week, a claim fails even before anything closed it');
select tests.assert_true(
  (select section = 'overdue' and overdue and eligible from public.list_chore_pool(tests.i('home-a'))
   where chore_id = tests.i('c-over')),
  'The other is in the Overdue unassigned section, still claimable');
select tests.assert_true(
  not exists (select 1 from public.list_chore_pool(tests.i('home-a')) where chore_id = tests.i('c-week')),
  'The closing one is not offered');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(
  tests.f(tests.first_occ('c-week'), 'status') = 'expired'
  and tests.f(tests.first_occ('c-week'), 'expired_at') is not null
  and tests.f(tests.first_occ('c-week'), 'closed_title') = 'Garage',
  'Opening the chores closes it as expired, with its title kept');
select tests.assert_true(tests.events(tests.first_occ('c-week')) = 'expired', 'One expiry event');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(tests.events(tests.first_occ('c-week')) = 'expired', 'Expiry is applied once');
select tests.assert_true(tests.f(tests.first_occ('c-over'), 'status') = 'open', 'The other stays open');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.complete_chore_occurrence(tests.first_occ('c-week'), tests.i('m-carol-a'))),
  'An expired chore cannot be completed');
select tests.assert_true(
  (select status = 'expired' from public.list_chore_history(tests.i('c-week'))),
  'Its history shows it closed unclaimed');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.skip_chore_occurrence(tests.first_occ('c-week'))),
  'Nor skipped');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.reopen_chore_occurrence(tests.first_occ('c-week'))),
  'Nor reopened (never silently brought back)');
select tests.assert_true(
  (select outcome = 'needs_confirmation' and (impact ->> 'expireNow')::integer = 1
   from public.set_chore_claim_policy(tests.i('c-over'), tests.chore_rev('c-over'), 'all', null, 'week_end', null, false)),
  'Switching the other to close after its week needs a confirmation: it would close at once');
select tests.assert_true(tests.f(tests.first_occ('c-over'), 'status') = 'open', 'Nothing changed yet');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_claim_policy(tests.i('c-over'), tests.chore_rev('c-over'),
    'all', null, 'week_end', null, false, true)),
  'Confirmed');
select tests.assert_true(tests.f(tests.first_occ('c-over'), 'status') = 'expired', 'It closed at once');

-- Week start ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_chore_settings(tests.i('home-a'), 0, 'sunday', false)),
  'A Member cannot change the Home''s chore settings');
select tests.assert_true(
  (select week_start = 'monday' and not reassignment_confirmation and revision = 0 and not can_manage
   from public.get_chore_settings(tests.i('home-a'))),
  'But reads the defaults');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.update_chore_settings(tests.i('home-a'), 0, 'sunday', false)),
  'The Owner starts the week on Sunday');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 1 from public.update_chore_settings(tests.i('home-a'), 0, 'monday', false)),
  'A stale revision is a conflict');
select tests.assert_true(
  (select bool_and(extract(isodow from week_start) = 7) from public.list_chore_pool(tests.i('home-a'), tests.today_a()))
  is not false,
  'The pool''s week now starts on a Sunday');
select tests.assert_true(tests.week_start('saturday', date '2026-10-21') = date '2026-10-17'
  and tests.week_start('monday', date '2026-10-19') = date '2026-10-19'
  and tests.week_start('sunday', date '2026-10-24') = date '2026-10-18',
  'Week starts for each convention');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_settings(tests.i('home-a'), 1, 'monday', false)),
  'Back to Monday');

-- Automatic release -------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-auto'), tests.i('home-a'), 'Oven',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'A chore with automatic release');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_claim_policy(tests.i('c-auto'), tests.chore_rev('c-auto'),
    'all', null, 'overdue', 24, false)),
  'Released 24 hours after its due day');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-auto'))),
  'Carol claims it');
select tests.assert_true(
  (select count(*) = 1 and bool_and(a = ((tests.today_a() + 1)::timestamp at time zone 'Europe/Brussels') + interval '24 hours')
   from tests.release_jobs(tests.first_occ('c-auto'), 1) a),
  'The release is queued for the end of the due day plus 24 hours, Home time');
select tests.assert_true(
  (select (s ->> 'releaseAt')::timestamptz = ((tests.today_a() + 1)::timestamp at time zone 'Europe/Brussels') + interval '24 hours'
   from public.get_chore_claim_state(tests.first_occ('c-auto')) s),
  'Its claim state shows when');
select tests.act_as_service_role();
select tests.assert_true(public.release_overdue_chore_claim(tests.first_occ('c-auto'), 1) = 'stale',
  'The job does nothing before the time');
select tests.assert_true(public.release_overdue_chore_claim(gen_random_uuid(), 1) = 'missing', 'Or for a missing one');
select tests.act_as_owner();
select tests.pool_shift_back('c-auto', 3);
select tests.act_as_service_role();
select tests.assert_true(public.release_overdue_chore_claim(tests.first_occ('c-auto'), 2) = 'stale',
  'A run for another claim does nothing');
select tests.assert_true(public.release_overdue_chore_claim(tests.first_occ('c-auto'), 1) = 'released',
  'Past the time, the job releases the claim');
select tests.assert_true(
  tests.who(tests.first_occ('c-auto')) = '' and tests.f(tests.first_occ('c-auto'), 'status') = 'open',
  'It is back in the pool (the chore stays available as overdue)');
select tests.assert_true(tests.events(tests.first_occ('c-auto')) = 'claimed,released:auto', 'As an automatic release');
select tests.assert_true(tests.notices('carol', 'chore.claim_released') = 1, 'Carol is told once');
select tests.assert_true(public.release_overdue_chore_claim(tests.first_occ('c-auto'), 1) = 'stale',
  'A repeated run changes nothing');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-auto'))),
  'Claiming it again is a new claim');
select tests.act_as_owner();
update private.chore_occurrences set in_rework = true where id = tests.first_occ('c-auto');
select tests.act_as('alice');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(tests.who(tests.first_occ('c-auto')) = 'carol', 'Needs rework is never released automatically');
select tests.act_as_owner();
update private.chore_occurrences set in_rework = false where id = tests.first_occ('c-auto');
select tests.act_as('alice');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(tests.who(tests.first_occ('c-auto')) = '', 'Opening the chores applies a due release too');
select tests.assert_true(tests.notices('carol', 'chore.claim_released') = 2, 'And tells her about that claim');

-- Claims and series or manager changes ---------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-rec'), tests.i('home-a'), 'Plants',
    '{"mode": "none", "members": []}', p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a())),
  'A daily unassigned chore');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.occ_on('c-rec', tests.today_a()))),
  'Carol claims today''s occurrence');
select tests.assert_true(tests.who(tests.occ_on('c-rec', tests.today_a() + 1)) = '',
  'Tomorrow''s stays unassigned (a claim is for one occurrence only)');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_series(tests.occ_on('c-rec', tests.today_a()), 'series',
    tests.f(tests.occ_on('c-rec', tests.today_a()), 'revision')::integer,
    tests.schedule_rev('c-rec'),
    false, jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-bob-a'))))),
  'The Owner assigns the whole series to Bob');
select tests.assert_true(tests.who(tests.occ_on('c-rec', tests.today_a())) = 'carol',
  'Carol keeps her claimed occurrence');
select tests.assert_true(tests.who(tests.occ_on('c-rec', tests.today_a() + 1)) = 'bob', 'The next one is Bob''s');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.occ_on('c-rec', tests.today_a()),
    tests.f(tests.occ_on('c-rec', tests.today_a()), 'revision')::integer, false,
    p_assignee_ids => array[tests.i('m-alice-a')])),
  'The Owner reassigns the claimed occurrence itself');
select tests.assert_true(
  tests.who(tests.occ_on('c-rec', tests.today_a())) = 'alice'
  and tests.f(tests.occ_on('c-rec', tests.today_a()), 'claimed_by') is null,
  'That ends the claim');

-- Reassignment requests ---------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-req'), tests.i('home-a'), 'Laundry',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    p_due_date => tests.today_a())),
  'A chore for Carol');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_assignee' from public.request_chore_reassignment(tests.i('r1'), tests.first_occ('c-req'), tests.i('m-alice-a'))),
  'Only an assignee asks to hand it over');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'invalid_recipient' from public.request_chore_reassignment(tests.i('r1'), tests.first_occ('c-req'), tests.i('m-carol-a'))),
  'Not to herself');
select tests.assert_true(
  (select outcome = 'invalid_recipient' from public.request_chore_reassignment(tests.i('r1'), tests.first_occ('c-req'), tests.i('m-bob-b'))),
  'Nor to a membership of another Home');
select tests.assert_denied(
  format($$select * from public.request_chore_reassignment(%L, %L, %L, %L)$$, tests.i('r1'),
    tests.first_occ('c-req'), tests.i('m-bob-a'), repeat('x', 201)),
  'A note is at most 200 characters', '22023');
select tests.assert_true(
  (select outcome = 'requested' and status = 'pending' from public.request_chore_reassignment(tests.i('r1'),
    tests.first_occ('c-req'), tests.i('m-bob-a'), '  Away   this weekend ')),
  'Carol asks Bob to take it over');
select tests.assert_true(
  tests.request_note('r1') = 'Away this weekend',
  'Her note is kept with its whitespace tidied');
select tests.assert_true(tests.who(tests.first_occ('c-req')) = 'carol', 'A request alone changes nothing');
select tests.assert_true(
  (select outcome = 'exists' from public.request_chore_reassignment(tests.i('r1'), tests.first_occ('c-req'), tests.i('m-bob-a'))),
  'A retry returns the same request');
select tests.assert_true(
  (select outcome = 'request_open' from public.request_chore_reassignment(tests.i('r2'), tests.first_occ('c-req'), tests.i('m-alice-a'))),
  'One open request per occurrence');
select tests.assert_true(tests.notices('bob', 'chore.reassignment_requested') = 1, 'Bob is asked');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 1 and bool_and(box = 'incoming' and to_me and from_member = tests.i('m-carol-a'))
   from public.list_chore_reassignment_requests(tests.i('home-a'))),
  'Bob sees the request waiting for him');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.answer_chore_reassignment(tests.i('r1'), 'cancel')),
  'Only Carol cancels it');
select tests.assert_true(
  (select outcome = 'declined' from public.answer_chore_reassignment(tests.i('r1'), 'decline')),
  'Bob declines');
select tests.assert_true(tests.who(tests.first_occ('c-req')) = 'carol', 'The chore stays with Carol');
select tests.assert_true(tests.notices('carol', 'chore.reassignment_answered') = 1, 'Carol is told');
select tests.assert_true(
  (select outcome = 'not_open' and status = 'declined' from public.answer_chore_reassignment(tests.i('r1'), 'accept')),
  'A declined request cannot be accepted');
-- A chore manager asks on behalf of an assignee; nobody else can.
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.request_chore_reassignment(tests.i('r7'), tests.first_occ('c-req'),
    tests.i('m-alice-a'), null, tests.i('m-carol-a'))),
  'Someone without chore rights cannot ask for another assignee');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_assignee' from public.request_chore_reassignment(tests.i('r7'), tests.first_occ('c-req'),
    tests.i('m-bob-a'), null, tests.i('m-bob-a'))),
  'The part handed over must belong to an assignee');
select tests.assert_true(
  (select outcome = 'invalid_recipient' from public.request_chore_reassignment(tests.i('r7'), tests.first_occ('c-req'),
    tests.i('m-carol-a'), null, tests.i('m-carol-a'))),
  'Not to the same person');
select tests.assert_true(
  (select outcome = 'requested' from public.request_chore_reassignment(tests.i('r7'), tests.first_occ('c-req'),
    tests.i('m-bob-a'), null, tests.i('m-carol-a'))),
  'Alice asks Bob to take over Carol''s part');
select tests.assert_true(
  tests.request_from_by('r7') = 'carol@madeora.test/alice@madeora.test',
  'It is from Carol, requested by Alice');
select tests.assert_true(
  (select outcome = 'cancelled' from public.answer_chore_reassignment(tests.i('r7'), 'cancel')),
  'Alice, who asked, cancels it');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'requested' from public.request_chore_reassignment(tests.i('r2'), tests.first_occ('c-req'), tests.i('m-bob-a'))),
  'Carol asks again');
select tests.assert_true(
  (select outcome = 'cancelled' from public.answer_chore_reassignment(tests.i('r2'), 'cancel')),
  'And cancels it');
select tests.assert_true(
  (select outcome = 'requested' from public.request_chore_reassignment(tests.i('r3'), tests.first_occ('c-req'), tests.i('m-bob-a'))),
  'A third request');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.answer_chore_reassignment(tests.i('r3'), 'accept')),
  'Only the recipient accepts');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'accepted' from public.answer_chore_reassignment(tests.i('r3'), 'accept')),
  'Bob accepts');
select tests.assert_true(tests.who(tests.first_occ('c-req')) = 'bob', 'The occurrence is his now');
select tests.assert_true(tests.events(tests.first_occ('c-req')) = 'reassigned', 'Recorded as a reassignment');
select tests.assert_true(
  (select outcome = 'not_open' from public.answer_chore_reassignment(tests.i('r3'), 'accept')),
  'A second acceptance changes nothing');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_settings(tests.i('home-a'), 2, 'monday', true)),
  'The Owner requires a chore manager''s confirmation');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'requested' from public.request_chore_reassignment(tests.i('r4'), tests.first_occ('c-req'), tests.i('m-carol-a'))),
  'Bob asks Carol to take it back');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'awaiting_manager' from public.answer_chore_reassignment(tests.i('r4'), 'accept')),
  'Carol accepts: it waits for a chore manager');
select tests.assert_true(tests.who(tests.first_occ('c-req')) = 'bob', 'Still Bob''s until then');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.answer_chore_reassignment(tests.i('r4'), 'confirm')),
  'Carol cannot confirm it herself');
select tests.assert_true(tests.notices('alice', 'chore.reassignment_confirmation_needed') = 1, 'Alice is asked');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 and bool_and(box = 'confirm') from public.list_chore_reassignment_requests(tests.i('home-a'))),
  'Alice sees it waiting for her');
select tests.assert_true(
  (select outcome = 'accepted' from public.answer_chore_reassignment(tests.i('r4'), 'confirm')),
  'Alice confirms');
select tests.assert_true(tests.who(tests.first_occ('c-req')) = 'carol', 'It is Carol''s again');
select tests.assert_true(tests.notices('bob', 'chore.reassignment_decided') = 1
  and tests.notices('carol', 'chore.reassignment_decided') = 1, 'Both are told');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'requested' from public.request_chore_reassignment(tests.i('r5'), tests.first_occ('c-req'), tests.i('m-bob-a'))),
  'Another request');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.first_occ('c-req'),
    tests.f(tests.first_occ('c-req'), 'revision')::integer, false, p_assignee_ids => array[tests.i('m-alice-a')])),
  'The Owner reassigns the occurrence directly');
select tests.assert_true(tests.req('r5') = 'invalidated:assignment_changed', 'That invalidates the request');
select tests.assert_true(tests.notices('bob', 'chore.reassignment_invalidated') = 1, 'And tells the recipient');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_open' and status = 'invalidated' from public.answer_chore_reassignment(tests.i('r5'), 'accept')),
  'A stale acceptance is refused');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'requested' from public.request_chore_reassignment(tests.i('r6'), tests.first_occ('c-req'), tests.i('m-bob-a'))),
  'Alice asks Bob');
select tests.assert_true(
  (select outcome = 'completed' from public.complete_chore_occurrence(tests.first_occ('c-req'), tests.i('m-alice-a'))),
  'And completes it herself');
select tests.assert_true(tests.req('r6') = 'invalidated:occurrence_closed', 'A completed occurrence ends the request');
select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_array_length(s -> 'requests') = 6 from public.get_chore_claim_state(tests.first_occ('c-req')) s),
  'Carol sees the requests she was part of (including the one made for her), not Alice''s to Bob');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_open' and status = 'invalidated' from public.answer_chore_reassignment(tests.i('r6'), 'accept')),
  'Bob cannot accept a request for a completed chore');

-- The Realtime signal ------------------------------------------------------------------------------------

set constraints all immediate;
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-b'))),
  'Bob claims his own chore in Home B');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 and bool_and(home_id = tests.i('home-a')) from public.chore_pool_signals),
  'Carol sees only her own Home''s signal');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 2 from public.chore_pool_signals),
  'Bob sees both of his Homes''');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chore_pool_signals'),
  'The signal table is published to Realtime');
select tests.assert_true(
  (select version = 1 from public.chore_pool_signals where home_id = tests.i('home-a')),
  'Every change of this transaction moved Home A''s signal once (the concurrency test checks one per request)');
set constraints all deferred;

-- Departure ----------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-dep'), tests.i('home-a'), 'Hall',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'One more unassigned chore');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-dep'))),
  'Carol claims it');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.assert_true(
  tests.who(tests.first_occ('c-dep')) = '' and not tests.f(tests.first_occ('c-dep'), 'needs_reassignment')::boolean
  and tests.f(tests.first_occ('c-dep'), 'claimed_by') is null,
  'When Carol leaves, her claim returns to the pool (not flagged)');
select tests.assert_true(tests.events(tests.first_occ('c-dep')) = 'claimed,released:departure', 'Recorded as such');

-- Audit --------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select count(*) > 0 from private.audit_events where home_id = tests.i('home-a')
     and action in ('chore_occurrence.claimed', 'chore_occurrence.released', 'chore_reassignment.requested',
       'chore_reassignment.accepted', 'chore.claim_policy_updated', 'chore_settings.updated')),
  'Claims, releases, requests, policies and settings are audited');
select tests.assert_true(
  not exists (select 1 from private.audit_events where home_id = tests.i('home-a')
    and (details::text like '%Windows%' or details::text like '%Away%' or details::text like '%Laundry%')),
  'Without titles or notes');
