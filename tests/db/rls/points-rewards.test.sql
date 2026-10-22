-- S23: points and rewards (supabase/migrations/*_points_rewards.sql). Alice owns Home A
-- (Europe/Brussels); Bob is an Administrator of Home A (granted capabilities as each case needs);
-- Carol and Gus are Members. Bob owns Home B; Dave belongs to no Home.
-- Covers: nothing reachable as a table; points on create, snapshot and prospective edits; on-time,
-- reduced and zero late awards at the Home-local day boundary; the contributor is paid; delayed
-- approval keeps the reported time; corrections, reopen and points corrections reconcile without
-- duplicates, and need manageHomePoints; pending points; balance privacy (another member, a reviewer
-- without points rights, a non-member, another Home); bonuses, corrections, insufficient points,
-- retries and reversal once; rewards (permissions, immediate, approval, independent reviewer,
-- rejection, cancellation by requester and manager, limits: total, per member per week, window;
-- archived while pending); fulfillment and refund once, replacement; point preservation on leaving
-- and rejoining, reservations released once, no transfer across Homes; the leaderboard (off by
-- default, ranking, ties, opt-out); the weekly overview (targets private unless shared);
-- notifications (points opt-in, rewards on).

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '34000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'gus@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '34000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member'),
  ((select id from ids where name = 'home-a'), '34000000-0000-4000-8000-000000000001', 'member');
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m
  join auth.users x on x.id = m.user_id, unnest(array['alice', 'bob', 'carol', 'gus']) u
  where m.home_id = (select id from ids where name = 'home-a') and x.email = u || '@madeora.test';
insert into ids select 'm-bob-b', m.id from public.home_memberships m
  where m.home_id = (select id from ids where name = 'home-b') and m.user_id = tests.user_id('bob');
insert into ids select n, gen_random_uuid() from unnest(array[
  'c-dishes', 'c-late', 'c-zero', 'c-edge', 'c-appr', 'c-rot', 'c-b', 'adj-1', 'adj-2', 'adj-3',
  'adj-4', 'r-ice', 'r-trip', 'r-week', 'r-window', 'r-alice', 'r-b', 'red-ice', 'red-ice2',
  'red-trip', 'red-trip2', 'red-gus', 'red-gus2', 'red-week', 'red-week2', 'red-alice', 'red-arch',
  'red-carol2', 'red-b', 'adj-gus', 'adj-alice'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.occ(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) order by scheduled_date limit 1; $$;
create function tests.orev(p_chore text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_occurrences where id = tests.occ(p_chore); $$;
create function tests.crev(p_chore text) returns integer
  language sql stable security definer as $$ select revision from private.chores where id = tests.i(p_chore); $$;
create function tests.acct(p_user text, p_home text default 'home-a') returns private.point_accounts
  language sql stable security definer as $$
  select * from private.point_accounts where home_id = tests.i(p_home) and user_id = tests.user_id(p_user); $$;
-- An account's available/reserved/balance as text, '0/0/0' when it has none.
create function tests.bal(p_user text, p_home text default 'home-a') returns text
  language sql stable security definer as $$
  select coalesce((select (balance - reserved) || '/' || reserved || '/' || balance from private.point_accounts
    where home_id = tests.i(p_home) and user_id = tests.user_id(p_user)), '0/0/0'); $$;
-- The kinds and amounts of an occurrence's ledger lines, in order.
create function tests.lines(p_chore text) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(e.kind || ':' || e.amount || ':' || split_part(u.email, '@', 1), ',' order by e.seq), '')
  from private.point_entries e join private.point_accounts a on a.id = e.account_id
  left join auth.users u on u.id = a.user_id where e.occurrence_id = tests.occ(p_chore); $$;
create function tests.rrev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.reward_redemptions where id = tests.i(p_name); $$;
create function tests.rstatus(p_name text) returns text
  language sql stable security definer as $$
  select status || ':' || coalesce(fulfillment, '-') || ':' || coalesce(resolution, '-')
  from private.reward_redemptions where id = tests.i(p_name); $$;
create function tests.wrev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.rewards where id = tests.i(p_name); $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications where user_id = tests.user_id(p_user) and kind = p_kind and show_in_app; $$;
-- Brussels wall-clock time on a day relative to today.
create function tests.at(p_offset integer, p_time text) returns timestamptz
  language sql stable as $$
  select ((tests.today_a() + p_offset)::text || ' ' || p_time)::timestamp at time zone 'Europe/Brussels'; $$;
-- Runs a boolean query as the test owner (the private schema is closed to API roles).
create function tests.sd(p_query text) returns boolean
  language plpgsql security definer as $$
  declare v boolean;
  begin execute p_query into v; return v; end $$;
create function tests.sdu(p_query text) returns uuid
  language plpgsql security definer as $$
  declare v uuid;
  begin execute p_query into v; return v; end $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable -----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied($$select * from private.point_accounts$$, 'Accounts are not a table anyone reads');
select tests.assert_denied($$select * from private.point_entries$$, 'The ledger is not a table anyone reads');
select tests.assert_denied($$select * from private.rewards$$, 'Rewards are not a table anyone reads');
select tests.assert_denied($$select * from private.reward_redemptions$$, 'Redemptions are not a table anyone reads');
select tests.assert_denied($$select private.reconcile_chore_points(null::private.chore_occurrences)$$,
  'Private functions are not callable');

-- Chore points: create, snapshot, prospective edits --------------------------------------------------------

select tests.assert_denied($$select * from public.create_chore(gen_random_uuid(), tests.i('home-a'), 'Too many',
  '{"mode": "none", "members": []}', p_due_date => tests.today_a(), p_points => 1001)$$,
  'More than 1000 points is refused', '22023');
select tests.assert_denied($$select * from public.create_chore(gen_random_uuid(), tests.i('home-a'), 'Reduced above',
  '{"mode": "none", "members": []}', p_due_date => tests.today_a(), p_points => 5, p_late_policy => 'reduced',
  p_late_points => 6)$$, 'Reduced late points above the base value are refused', '22023');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-dishes'), tests.i('home-a'), 'Dishes',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a(), p_points => 10,
    p_late_policy => 'reduced', p_late_points => 4)),
  'A one-off chore worth 10 points, 4 when late');
select tests.assert_true(
  tests.sd($q$select points = 10 and late_policy = 'reduced' and late_points = 4 from private.chore_occurrences
    where id = tests.occ('c-dishes')$q$),
  'Its occurrence snapshots the points');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-rot'), tests.i('home-a'), 'Plants',
    '{"mode": "none", "members": []}', p_frequency => 'daily', p_interval => 1,
    p_starts_on => tests.today_a(), p_points => 5)),
  'A daily chore worth 5');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore(tests.i('c-rot'), tests.crev('c-rot'), 'Plants',
    p_points => 8, p_late_policy => 'zero')),
  'Raising its points to 8 (zero when late)');
select tests.assert_true(
  tests.sd($q$select bool_and(points = 5 and late_policy = 'full') from private.chore_occurrences where chore_id = tests.i('c-rot')$q$),
  'Occurrences created before the change keep their snapshot (spec: prospective)');
select tests.assert_true(
  ((public.get_chore_points(tests.occ('c-rot')) -> 'chore' ->> 'scheduledOther')::integer >= 1),
  'The chore shows how many created occurrences keep another value');
select tests.act_as_owner();
select private.create_chore_occurrence(
  (select s from private.chore_schedules s where s.chore_id = tests.i('c-rot') and s.superseded_at is null),
  tests.today_a() + 30);
select tests.assert_true(
  tests.sd($q$select points = 8 and late_policy = 'zero' from private.chore_occurrences
    where chore_id = tests.i('c-rot') and scheduled_date = tests.today_a() + 30$q$),
  'A later occurrence takes the new value');

-- Awards: another member's completion pays the contributor, once ----------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select (public.get_chore_points(tests.occ('c-dishes')) ->> 'expectedNow')::integer = 10),
  'Members see what completing now earns');
select tests.assert_true(
  (select outcome = 'completed' from public.complete_chore_occurrence(tests.occ('c-dishes'), tests.i('m-gus-a'))),
  'Carol records that Gus did the dishes');
select tests.assert_true(tests.lines('c-dishes') = 'chore_award:10:gus', 'Gus, the contributor, earns the 10 points');
select tests.assert_true(tests.bal('carol') = '0/0/0', 'Carol, who recorded it, earns nothing');
select tests.assert_true(
  (select outcome = 'already_completed' from public.complete_chore_occurrence(tests.occ('c-dishes'), tests.i('m-carol-a'))),
  'A second completion is refused');
select tests.assert_true(tests.lines('c-dishes') = 'chore_award:10:gus', 'and pays nothing twice');
select tests.assert_true(tests.notices('gus', 'points.awarded') = 0,
  'Points notices are opt-in: none by default');

-- Late awards at the Home-local day boundary ---------------------------------------------------------

select tests.act_as('alice');
select public.create_chore(tests.i('c-late'), tests.i('home-a'), 'Windows', '{"mode": "none", "members": []}',
  p_due_date => tests.today_a() - 2, p_points => 10, p_late_policy => 'reduced', p_late_points => 3);
select public.create_chore(tests.i('c-zero'), tests.i('home-a'), 'Garage', '{"mode": "none", "members": []}',
  p_due_date => tests.today_a() - 2, p_points => 10, p_late_policy => 'zero');
select public.create_chore(tests.i('c-edge'), tests.i('home-a'), 'Attic', '{"mode": "none", "members": []}',
  p_due_date => tests.today_a() - 2, p_points => 10, p_late_policy => 'zero');
select tests.act_as('carol');
select tests.assert_true(
  (select (p ->> 'expectedNow')::integer = 3 and (p ->> 'lateNow')::boolean
   from public.get_chore_points(tests.occ('c-late')) p),
  'An overdue occurrence shows the reduced amount');
select public.complete_chore_occurrence(tests.occ('c-late'), tests.i('m-carol-a'));
select public.complete_chore_occurrence(tests.occ('c-zero'), tests.i('m-carol-a'));
select public.complete_chore_occurrence(tests.occ('c-edge'), tests.i('m-carol-a'));
select tests.assert_true(tests.lines('c-late') = 'chore_award:3:carol', 'Late with the reduced policy: 3 points');
select tests.assert_true(
  tests.sd($q$select late from private.point_entries where occurrence_id = tests.occ('c-late')$q$),
  'The award records that it was late');
select tests.assert_true(tests.lines('c-zero') = '', 'Late with the zero policy: nothing');

select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeChores']) = 'ok',
  'Bob may manage chores, not points');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'points_not_permitted' from public.correct_chore_completion(tests.occ('c-edge'),
    tests.orev('c-edge'), p_completed_at => tests.at(-2, '23:30'))),
  'A correction that changes awarded points needs manageHomePoints too');
select tests.assert_true(
  (select outcome = 'corrected' from public.correct_chore_completion(tests.occ('c-edge'),
    tests.orev('c-edge'), p_set_note => true, p_note => 'Done well')),
  'A correction that changes no points needs only chore management');
select tests.assert_true(public.preview_chore_points_change(tests.occ('c-edge'), 'correct',
    p_completed_at => tests.at(-2, '23:30')) ->> 'toAmount' = '10'
  and (public.preview_chore_points_change(tests.occ('c-edge'), 'correct',
    p_completed_at => tests.at(-2, '23:30')) -> 'affected' -> 0 ->> 'availableAfter') is null
  and not (public.preview_chore_points_change(tests.occ('c-edge'), 'correct',
    p_completed_at => tests.at(-2, '23:30')) ->> 'permitted')::boolean,
  'The preview shows the change but not balances to someone without points rights');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'corrected' from public.correct_chore_completion(tests.occ('c-edge'),
    tests.orev('c-edge'), p_completed_at => tests.at(-2, '23:30'))),
  'Alice corrects the time to 23:30 Brussels on the due day');
select tests.assert_true(tests.lines('c-edge') = 'chore_award:10:carol',
  '23:30 local on the due day is on time (21:30 or 22:30 UTC): 10 points');
select tests.assert_true(
  (select outcome = 'corrected' from public.correct_chore_completion(tests.occ('c-edge'),
    tests.orev('c-edge'), p_completed_at => tests.at(-1, '00:30'))),
  'Corrected to 00:30 the next local day');
select tests.assert_true(tests.lines('c-edge') = 'chore_award:10:carol,chore_reversal:-10:carol',
  'Now late with the zero policy: the award is reversed, nothing new');
select tests.assert_true(
  (select outcome = 'corrected' from public.correct_chore_completion(tests.occ('c-edge'),
    tests.orev('c-edge'), p_contributor => tests.i('m-gus-a'), p_completed_at => tests.at(-2, '12:00'))),
  'Corrected to Gus, on time');
select tests.assert_true(tests.lines('c-edge') =
  'chore_award:10:carol,chore_reversal:-10:carol,chore_award:10:gus',
  'The correct contributor is paid, the history kept');
select tests.assert_true(
  tests.sd($q$select attributed_at = tests.at(-2, '12:00') from private.point_entries
   where occurrence_id = tests.occ('c-edge') order by seq desc limit 1$q$),
  'The award is attributed to the completion time');

-- Delayed approval keeps the reported time ------------------------------------------------------------

select public.create_chore(tests.i('c-appr'), tests.i('home-a'), 'Oven', '{"mode": "none", "members": []}',
  p_due_date => tests.today_a() - 1, p_points => 7, p_late_policy => 'zero', p_requires_approval => true);
select tests.act_as('carol');
select public.complete_chore_occurrence(tests.occ('c-appr'), tests.i('m-carol-a'));
select tests.act_as_owner();
update private.chore_submissions set submitted_at = tests.at(-1, '18:00')
  where occurrence_id = tests.occ('c-appr') and status = 'pending';
select tests.act_as('carol');
select tests.assert_true(tests.lines('c-appr') = '', 'Nothing is earned while pending');
select tests.assert_true(
  (public.get_point_summary(tests.i('home-a')) -> 'week' ->> 'pending')::integer >= 0
  and (public.get_chore_points(tests.occ('c-appr')) -> 'pending' ->> 'amount')::integer = 7,
  'The pending award is shown, at the reported time');
select tests.act_as('alice');
select public.review_chore_submission(tests.occ('c-appr'), tests.orev('c-appr'), 'approve');
select tests.assert_true(tests.lines('c-appr') = 'chore_award:7:carol',
  'Approved a day after the due date, the award still counts the reported on-time completion');

-- Reopen and points corrections ----------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'points_not_permitted' from public.reopen_chore_occurrence(tests.occ('c-appr'))),
  'Reopening an occurrence that carries points needs manageHomePoints');
select tests.assert_true(
  (select outcome = 'points_not_permitted' from public.set_chore_occurrence_points(tests.occ('c-appr'),
    tests.orev('c-appr'), 9, 'full', p_reason => 'More work')),
  'So does correcting a completed occurrence''s points');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'reason_required' from public.set_chore_occurrence_points(tests.occ('c-appr'),
    tests.orev('c-appr'), 9, 'full')),
  'A completed occurrence''s points correction needs a reason');
select tests.assert_true(
  (select outcome = 'preview' and (impact -> 'change' ->> 'toAmount')::integer = 9
     and (impact -> 'change' -> 'affected' -> 0 ->> 'change')::integer = 2
   from public.set_chore_occurrence_points(tests.occ('c-appr'), tests.orev('c-appr'), 9, 'full',
     p_reason => 'More work', p_dry_run => true)),
  'The preview shows the change for Carol');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_occurrence_points(tests.occ('c-appr'),
    tests.orev('c-appr'), 9, 'full', p_reason => 'More work')),
  'Alice corrects it to 9');
select tests.assert_true(tests.lines('c-appr') = 'chore_award:7:carol,chore_reversal:-7:carol,chore_award:9:carol',
  'Reconciled with a reversal and a new award');
select tests.assert_true(
  (select outcome = 'reopened' from public.reopen_chore_occurrence(tests.occ('c-appr'))),
  'Alice reopens it');
select tests.assert_true(tests.lines('c-appr') =
  'chore_award:7:carol,chore_reversal:-7:carol,chore_award:9:carol,chore_reversal:-9:carol',
  'Reopening reverses the award');
select tests.assert_true(tests.bal('carol') = '3/0/3', 'Carol keeps only the late Windows award');
select tests.assert_true(tests.bal('gus') = '20/0/20', 'Gus has his two awards');

-- Privacy -----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (public.get_point_summary(tests.i('home-a')) -> 'totals' ->> 'available')::integer = 3,
  'Carol sees her own balance');
select tests.assert_denied(
  format('select public.list_point_entries(%L, %L)', tests.i('home-a'), (tests.acct('gus')).id),
  'Carol cannot read Gus''s ledger');
select tests.assert_denied(format('select * from public.list_point_accounts(%L)', tests.i('home-a')),
  'Carol cannot list balances');
select tests.assert_true(
  (select bool_and(e ->> 'kind' <> 'bonus') from jsonb_array_elements(
    (public.get_chore_points(tests.occ('c-edge')) -> 'entries')) e),
  'Chore points show ledger lines, never balances');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'),
  array['manageHomeChores', 'approveHomeRewards']);
select tests.act_as('bob');
select tests.assert_denied(
  format('select public.list_point_entries(%L, %L)', tests.i('home-a'), (tests.acct('gus')).id),
  'A reward reviewer without manageHomePoints cannot read balances');
select tests.assert_denied(
  format('select public.list_point_entries(%L, %L)', tests.i('home-b'), (tests.acct('gus')).id),
  'An account is never readable through another Home');
select tests.act_as('dave');
select tests.assert_denied(format('select public.get_point_summary(%L)', tests.i('home-a')),
  'A non-member reads nothing');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 4 from public.list_point_accounts(tests.i('home-a'))),
  'The Owner (manageHomePoints) lists every member''s balance');
select tests.assert_true(
  (public.list_point_entries(tests.i('home-a'), (tests.acct('gus')).id) -> 'account' ->> 'available')::integer = 20,
  'and reads Gus''s ledger');

-- Manual adjustments --------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.adjust_points(tests.i('adj-1'), tests.i('home-a'),
    tests.i('m-carol-a'), 'bonus', 50, 'Great week')),
  'Reviewing rewards or managing chores never implies adjusting balances');
select tests.act_as('alice');
select tests.assert_denied(format($$select * from public.adjust_points(%L, %L, %L, 'bonus', 50, 'ok')$$,
  tests.i('adj-1'), tests.i('home-a'), tests.i('m-carol-a')), 'A meaningful reason is required', '22023');
select tests.assert_true(
  (select outcome = 'preview' and (preview ->> 'availableAfter')::integer = 53
   from public.adjust_points(tests.i('adj-1'), tests.i('home-a'), tests.i('m-carol-a'), 'bonus', 50,
     'Great week', true)),
  'The preview shows the resulting balance');
select tests.assert_true(
  (select outcome = 'posted' from public.adjust_points(tests.i('adj-1'), tests.i('home-a'),
    tests.i('m-carol-a'), 'bonus', 50, 'Great week')),
  'A bonus of 50 for Carol');
select tests.assert_true(
  (select outcome = 'exists' from public.adjust_points(tests.i('adj-1'), tests.i('home-a'),
    tests.i('m-carol-a'), 'bonus', 50, 'Great week')),
  'A retry posts nothing twice');
select tests.assert_true(tests.bal('carol') = '53/0/53', 'Carol now has 53');
select tests.assert_true(tests.notices('carol', 'points.bonus') = 1, 'Carol is told about the adjustment');
select tests.assert_true(
  (select outcome = 'insufficient_points' from public.adjust_points(tests.i('adj-2'), tests.i('home-a'),
    tests.i('m-carol-a'), 'correction', -60, 'Mistaken bonus')),
  'A debit beyond the available points is refused, nothing partial');
select tests.assert_true(
  (select outcome = 'posted' from public.adjust_points(tests.i('adj-2'), tests.i('home-a'),
    tests.i('m-carol-a'), 'correction', -3, 'Counted twice')),
  'A negative correction within the balance');
select tests.assert_true(
  (select outcome = 'reversed' from public.reverse_point_entry(tests.i('adj-2'), 'Was right after all')),
  'Reversing the correction');
select tests.assert_true(
  (select outcome = 'already_reversed' from public.reverse_point_entry(tests.i('adj-2'), 'Was right after all')),
  'An entry is reversed once');
select tests.assert_true(
  (select outcome = 'not_reversible' from public.reverse_point_entry(
    tests.sdu($q$select id from private.point_entries where occurrence_id = tests.occ('c-late')$q$), 'Not manual')),
  'Chore awards are not reversed by hand');
select tests.assert_true(tests.bal('carol') = '53/0/53', 'Carol is back at 53');
select tests.assert_true(
  tests.sd($q$select count(*) = 1 from private.point_entries where reverses_id = tests.i('adj-2')
     and reason = 'Was right after all' and kind = 'manual_reversal'$q$),
  'The reversal is linked and keeps its reason');

-- Rewards --------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_reward(tests.i('r-ice'), tests.i('home-a'), 'Ice cream', 20)),
  'Members do not manage rewards');
select tests.act_as('alice');
select public.create_reward(tests.i('r-ice'), tests.i('home-a'), 'Ice cream', 20);
select public.create_reward(tests.i('r-trip'), tests.i('home-a'), 'Cinema', 30, p_requires_approval => true,
  p_total_limit => 1);
select public.create_reward(tests.i('r-week'), tests.i('home-a'), 'Late night', 5, p_member_limit => 1,
  p_member_period => 'week');
select public.create_reward(tests.i('r-window'), tests.i('home-a'), 'Summer treat', 5,
  p_available_from => tests.today_a() + 1);
select tests.assert_true(
  (select outcome = 'exists' from public.create_reward(tests.i('r-ice'), tests.i('home-a'), 'Ice cream', 20)),
  'Creating twice returns the existing reward');

select tests.act_as('carol');
select tests.assert_true(jsonb_array_length(public.list_rewards(tests.i('home-a'))) = 4, 'Members see the catalog');
select tests.assert_true(
  (select outcome = 'not_started' from public.redeem_reward(tests.i('red-ice'), tests.i('r-window'), 5)),
  'A reward before its window cannot be redeemed');
select tests.assert_true(
  (select outcome = 'cost_changed' from public.redeem_reward(tests.i('red-ice'), tests.i('r-ice'), 15)),
  'A stale cost asks the member to confirm the current one');
select tests.assert_true(
  (select outcome = 'preview' and (detail ->> 'availableAfter')::integer = 33
   from public.redeem_reward(tests.i('red-ice'), tests.i('r-ice'), 20, true)),
  'The preview shows the balance after');
select tests.assert_true(
  (select outcome = 'redeemed' from public.redeem_reward(tests.i('red-ice'), tests.i('r-ice'), 20)),
  'An immediate reward is redeemed at once');
select tests.assert_true(
  (select outcome = 'exists' from public.redeem_reward(tests.i('red-ice'), tests.i('r-ice'), 20)),
  'A retry returns the same redemption');
select tests.assert_true(tests.bal('carol') = '33/0/33' and tests.rstatus('red-ice') = 'redeemed:pending:-',
  'The cost is deducted once, and fulfillment is pending');

-- Approval required: reservation, capacity, independent reviewer.
select tests.assert_true(
  (select outcome = 'requested' from public.redeem_reward(tests.i('red-trip'), tests.i('r-trip'), 30)),
  'Carol requests the cinema');
select tests.assert_true(tests.bal('carol') = '3/30/33', 'Its cost is reserved, not spent');
select tests.assert_true(tests.notices('bob', 'reward.requested') = 1 and tests.notices('alice', 'reward.requested') = 1
  and tests.notices('carol', 'reward.requested') = 0,
  'Every reviewer but the requester is told');
select tests.assert_true(
  (select outcome = 'insufficient_points' from public.redeem_reward(tests.i('red-ice2'), tests.i('r-ice'), 20)),
  'Reserved points cannot be spent elsewhere');
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'sold_out' from public.redeem_reward(tests.i('red-gus'), tests.i('r-trip'), 30)),
  'A pending request holds the last capacity');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.review_reward_redemption(tests.i('red-trip'), tests.rrev('red-trip'), 'approve')),
  'Members do not approve');
select tests.act_as('alice');
select public.update_reward(tests.i('r-trip'), tests.wrev('r-trip'), 'Cinema', 40, p_requires_approval => true,
  p_total_limit => 1);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'approved' from public.review_reward_redemption(tests.i('red-trip'), tests.rrev('red-trip'), 'approve')),
  'Bob, a different reviewer, approves it');
select tests.assert_true(tests.bal('carol') = '3/0/3' and tests.rstatus('red-trip') = 'redeemed:pending:-',
  'The reservation becomes one deduction of the original cost (a later price edit changes nothing)');
select tests.assert_true(
  tests.sd($q$select count(*) = 1 from private.point_entries where redemption_id = tests.i('red-trip')$q$),
  'Exactly one ledger entry for it');
select tests.assert_true(
  (select outcome = 'not_pending' from public.review_reward_redemption(tests.i('red-trip'), tests.rrev('red-trip'), 'approve')),
  'Approving twice changes nothing');
select tests.assert_true(tests.notices('carol', 'reward.approved') = 1, 'Carol is told');

-- The Owner as requester can never approve their own request.
select tests.act_as('alice');
select public.create_reward(tests.i('r-alice'), tests.i('home-a'), 'Spa', 10, p_requires_approval => true);
select public.adjust_points(tests.i('adj-alice'), tests.i('home-a'), tests.i('m-alice-a'), 'bonus', 10, 'Own points');
select tests.assert_true(
  (select outcome = 'requested' from public.redeem_reward(tests.i('red-alice'), tests.i('r-alice'), 10)),
  'Alice requests a reward');
select tests.assert_true(
  (select outcome = 'own_request' from public.review_reward_redemption(tests.i('red-alice'), tests.rrev('red-alice'), 'approve')),
  'The Owner cannot approve her own request');
select tests.assert_true(
  public.get_reward_redemption(tests.i('red-alice')) ->> 'blocker' = 'own_request'
  and not (public.get_reward_redemption(tests.i('red-alice')) ->> 'canApprove')::boolean,
  'and is told why');
select tests.assert_true(
  (select bool_and(jsonb_typeof(public.get_reward_redemption(tests.i('red-alice')) -> flag) = 'boolean')
   from unnest(array['canApprove', 'canCancel', 'canFulfil', 'canResolve', 'canSetReplacement']) flag),
  'Every action flag is true or false, never null, for a rewards manager');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeChores']);
select tests.assert_true(
  public.get_reward_redemption(tests.i('red-alice')) ->> 'blocker' = 'own_request',
  'With no other reviewer the request stays pending');
select tests.assert_true(tests.rstatus('red-alice') = 'pending:-:-', 'never auto-approved');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'),
  array['manageHomeChores', 'approveHomeRewards']);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'approved' from public.review_reward_redemption(tests.i('red-alice'), tests.rrev('red-alice'), 'approve')),
  'Bob approves it');

-- Rejection, cancellation.
select tests.act_as('alice');
select public.adjust_points(tests.i('adj-gus'), tests.i('home-a'), tests.i('m-gus-a'), 'bonus', 100, 'Moved boxes');
select public.create_reward(tests.i('r-b'), tests.i('home-a'), 'Pizza', 15, p_requires_approval => true);
select tests.act_as('gus');
select public.redeem_reward(tests.i('red-gus'), tests.i('r-b'), 15);
select public.redeem_reward(tests.i('red-gus2'), tests.i('r-b'), 15);
select tests.assert_true(tests.bal('gus') = '90/30/120', 'Two requests reserve 30');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'rejected' from public.review_reward_redemption(tests.i('red-gus'), tests.rrev('red-gus'),
    'reject', 'Not this week')),
  'Bob rejects one');
select tests.assert_true(tests.bal('gus') = '105/15/120', 'Rejection releases its reservation');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.cancel_reward_redemption(tests.i('red-gus2'), tests.rrev('red-gus2'), 'Too late')),
  'A reviewer without manageHomeRewards cannot cancel someone else''s request');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'reason_required' from public.cancel_reward_redemption(tests.i('red-gus2'), tests.rrev('red-gus2'))),
  'A manager''s cancellation needs a reason');
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'cancelled' from public.cancel_reward_redemption(tests.i('red-gus2'), tests.rrev('red-gus2'))),
  'Gus cancels his own request without a reason');
select tests.assert_true(
  (select outcome = 'not_pending' from public.cancel_reward_redemption(tests.i('red-gus2'), tests.rrev('red-gus2'))),
  'Cancelling twice releases nothing twice');
select tests.assert_true(tests.bal('gus') = '120/0/120', 'Everything released exactly once');

-- Archived while pending.
select public.redeem_reward(tests.i('red-arch'), tests.i('r-b'), 15);
select tests.act_as('alice');
select public.archive_reward(tests.i('r-b'), tests.wrev('r-b'), true);
select tests.act_as('gus');
select tests.assert_true(jsonb_array_length(public.list_rewards(tests.i('home-a'))) = 5,
  'An archived reward leaves the catalog');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'reward_unavailable' and detail ->> 'reason' = 'archived'
   from public.review_reward_redemption(tests.i('red-arch'), tests.rrev('red-arch'), 'approve')),
  'Approving a request for an archived reward asks for confirmation');
select tests.assert_true(
  (select outcome = 'approved' from public.review_reward_redemption(tests.i('red-arch'), tests.rrev('red-arch'),
    'approve', p_confirm => true)),
  'Confirmed, it is approved');

-- Per-member limit per week, at the boundary.
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'redeemed' from public.redeem_reward(tests.i('red-week'), tests.i('r-week'), 5)),
  'Once this week');
select tests.assert_true(
  (select outcome = 'member_limit' and (detail ->> 'nextEligibleOn')::date > tests.today_a()
   from public.redeem_reward(tests.i('red-week2'), tests.i('r-week'), 5)),
  'Twice in the same week is refused, with the next eligible day');
select tests.act_as_owner();
update private.reward_redemptions set requested_at = now() - interval '8 days' where id = tests.i('red-week');
select tests.act_as('gus');
select tests.assert_true(
  (select outcome = 'redeemed' from public.redeem_reward(tests.i('red-week2'), tests.i('r-week'), 5)),
  'A redemption from last week does not count against this week');

-- Fulfillment and resolution -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_reward_fulfillment(tests.i('red-trip'), tests.rrev('red-trip'), 'fulfilled')),
  'Members do not mark fulfillment');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.set_reward_fulfillment(tests.i('red-trip'), tests.rrev('red-trip'), 'unable',
    'Cinema closed')),
  'Alice marks the cinema Unable to fulfill');
select tests.assert_true(tests.bal('carol') = '3/0/3', 'Unable to fulfill never refunds by itself');
select tests.assert_true(
  (select outcome = 'reason_required' from public.set_reward_fulfillment(tests.i('red-trip'), tests.rrev('red-trip'), 'pending')),
  'Correcting a fulfillment state needs a reason');
select tests.assert_true(
  (select outcome = 'preview' from public.resolve_reward_redemption(tests.i('red-trip'), tests.rrev('red-trip'),
    'refund', p_dry_run => true)),
  'A refund is previewed');
select tests.assert_true(
  (select outcome = 'resolved' from public.resolve_reward_redemption(tests.i('red-trip'), tests.rrev('red-trip'), 'refund')),
  'and confirmed');
select tests.assert_true(tests.bal('carol') = '33/0/33', 'The original 30 come back');
select tests.assert_true(
  (select outcome = 'already_resolved' from public.resolve_reward_redemption(tests.i('red-trip'), tests.rrev('red-trip'), 'refund')),
  'A refund happens once');
select tests.assert_true(
  tests.sd($q$select count(*) = 1 from private.point_entries where redemption_id = tests.i('red-trip') and kind = 'refund'$q$),
  'One refund entry, linked');
select tests.assert_true(tests.notices('carol', 'reward.refunded') = 1, 'Carol is told');
-- Replacement.
select public.set_reward_fulfillment(tests.i('red-ice'), tests.rrev('red-ice'), 'unable');
select tests.assert_true(
  (select outcome = 'resolved' from public.resolve_reward_redemption(tests.i('red-ice'), tests.rrev('red-ice'),
    'replacement', p_replacement => 'Chocolate instead', p_responsible => tests.i('m-bob-a'))),
  'A replacement is arranged');
select tests.assert_true(tests.bal('carol') = '33/0/33', 'never charged again');
select tests.assert_true(
  (select outcome = 'saved' from public.set_replacement_outcome(tests.i('red-ice'), tests.rrev('red-ice'), 'fulfilled')),
  'The replacement is fulfilled');

-- Departure and rejoining ---------------------------------------------------------------------------------

select tests.act_as('gus');
select public.redeem_reward(tests.i('red-carol2'), tests.i('r-alice'), 10);
select tests.assert_true(tests.bal('gus') = '85/10/95', 'Gus has a pending request');
select tests.assert_true(public.leave_home(tests.i('home-a')) = 'left', 'Gus leaves the Home');
select tests.assert_true(tests.bal('gus') = '95/0/95', 'His reservation is released once; the balance stays');
select tests.assert_true(
  tests.sd($q$select status = 'cancelled' and departed from private.reward_redemptions where id = tests.i('red-carol2')$q$),
  'The request is cancelled because he left');
select tests.assert_denied(format('select public.get_point_summary(%L)', tests.i('home-a')),
  'Gone, he cannot see or spend it');
select tests.act_as('alice');
select tests.assert_true(
  (select former from public.list_point_accounts(tests.i('home-a')) where account_id = (tests.acct('gus')).id),
  'Managers still see his preserved account as a former member''s');
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values (tests.i('home-a'), '34000000-0000-4000-8000-000000000001', 'member');
update ids set id = (select m.id from public.home_memberships m where m.home_id = tests.i('home-a')
  and m.user_id = '34000000-0000-4000-8000-000000000001') where name = 'm-gus-a';
select tests.act_as('gus');
select tests.assert_true(
  (public.get_point_summary(tests.i('home-a')) -> 'totals' ->> 'available')::integer = 95
  and tests.sd($q$select count(*) = 1 from private.point_accounts where user_id = tests.user_id('gus')$q$),
  'Rejoining with the same account restores the same balance, no new account');
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values (tests.i('home-b'), '34000000-0000-4000-8000-000000000001', 'member');
select tests.act_as('gus');
select tests.assert_true(
  (public.get_point_summary(tests.i('home-b')) -> 'totals' ->> 'available')::integer = 0,
  'Another Home never sees these points');

-- Leaderboard -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(not (public.get_point_leaderboard(tests.i('home-a')) ->> 'enabled')::boolean,
  'The leaderboard is off by default');
select tests.assert_true(public.update_point_settings(tests.i('home-a'), true, 'week') = 'not_permitted',
  'Members do not turn it on');
select tests.act_as('alice');
select tests.assert_true(public.update_point_settings(tests.i('home-a'), true, 'month') = 'saved',
  'Alice turns it on, monthly by default');
select tests.act_as('carol');
select tests.assert_true(
  (select l ->> 'period' = 'month' and jsonb_array_length(l -> 'rows') = 4 from public.get_point_leaderboard(tests.i('home-a')) l),
  'Every participating member is listed for the default period');
select tests.assert_true(
  (select bool_and((r ->> 'rank')::integer = 1) from jsonb_array_elements(
     public.get_point_leaderboard(tests.i('home-a'), 'all') -> 'rows') r
   where (r ->> 'member')::uuid = tests.i('m-gus-a')),
  'Gus leads all time (earned points, not balances)');
select tests.assert_true(
  (select string_agg(r ->> 'rank', ',' order by (r ->> 'rank')::integer) from jsonb_array_elements(
     public.get_point_leaderboard(tests.i('home-a'), 'all') -> 'rows') r) ~ '^1,2,',
  'Ranks follow earned points');
select tests.assert_true(
  (select bool_and(not (r ? 'available') and not (r ? 'reserved')) from jsonb_array_elements(
     public.get_point_leaderboard(tests.i('home-a'), 'all') -> 'rows') r),
  'Never balances or reservations');
select tests.act_as('gus');
select tests.assert_true(public.update_point_preferences(tests.i('home-a'), p_participates => false) = 'saved',
  'Gus opts out, no approval needed');
select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_array_length(l -> 'rows') = 3 and not exists (
     select 1 from jsonb_array_elements(l -> 'rows') r where (r ->> 'member')::uuid = tests.i('m-gus-a'))
   from public.get_point_leaderboard(tests.i('home-a'), 'all') l),
  'He disappears from every period, and is not counted');
select tests.assert_true(
  (select (r ->> 'rank')::integer = 1 from jsonb_array_elements(
     public.get_point_leaderboard(tests.i('home-a'), 'all') -> 'rows') r
   where (r ->> 'member')::uuid = tests.i('m-carol-a')),
  'Visible members are ranked without him: Carol now leads');
select tests.assert_true(
  (select coalesce(bool_and(r ->> 'member' is not null), true) from jsonb_array_elements(
     public.get_weekly_points(tests.i('home-a'), true) -> 'members') r)
  and not exists (select 1 from jsonb_array_elements(public.get_weekly_points(tests.i('home-a'), true) -> 'members') r
    where (r ->> 'member')::uuid = tests.i('m-gus-a')),
  'Nor does he appear in the shared weekly overview');
-- Ties share a rank: Carol and Bob both at 0 this week, no completions.
select tests.act_as('alice');
select tests.assert_true(
  (select count(distinct r ->> 'rank') = 1 from jsonb_array_elements(
     public.get_point_leaderboard(tests.i('home-a'), 'week') -> 'rows') r
   where (r ->> 'earned')::integer = 0 and (r ->> 'completed')::integer = 0),
  'Equal points and equal completions share a rank');

-- Weekly targets ------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(public.update_point_preferences(tests.i('home-a'), p_set_target => true, p_target => 40) = 'saved',
  'Carol sets a weekly target');
select tests.assert_true((public.get_weekly_points(tests.i('home-a')) -> 'me' ->> 'target')::integer = 40,
  'She sees it');
select tests.act_as('alice');
select tests.assert_true(
  (select r -> 'target' = 'null'::jsonb from jsonb_array_elements(public.get_weekly_points(tests.i('home-a'), true) -> 'members') r
   where (r ->> 'member')::uuid = tests.i('m-carol-a')),
  'Others do not see her target unless she shares it');
select tests.act_as('carol');
select public.update_point_preferences(tests.i('home-a'), p_share_target => true);
select tests.act_as('alice');
select tests.assert_true(
  (select (r ->> 'target')::integer = 40 from jsonb_array_elements(public.get_weekly_points(tests.i('home-a'), true) -> 'members') r
   where (r ->> 'member')::uuid = tests.i('m-carol-a')),
  'Shared, it shows');
select tests.act_as('carol');
select public.update_point_preferences(tests.i('home-a'), p_set_target => true, p_target => 0);
select tests.assert_true(public.get_weekly_points(tests.i('home-a')) -> 'me' -> 'target' = 'null'::jsonb,
  'A zero target means none');

-- Points notifications are opt-in -------------------------------------------------------------------------

select public.set_notification_preference('points', 'in_app', true, tests.i('home-a'));
select tests.act_as('alice');
select public.create_chore(tests.i('c-b'), tests.i('home-a'), 'Bathroom', '{"mode": "none", "members": []}',
  p_due_date => tests.today_a(), p_points => 6);
select tests.act_as('carol');
select public.complete_chore_occurrence(tests.occ('c-b'), tests.i('m-carol-a'));
select tests.assert_true(tests.notices('carol', 'points.awarded') = 1, 'Opted in, Carol is told once');
select tests.assert_true(
  tests.sd($q$select (params ->> 'amount')::integer = 6 from public.notifications where user_id = tests.user_id('carol')
    and kind = 'points.awarded'$q$),
  'with the amount');
select tests.act_as('alice');
select public.reopen_chore_occurrence(tests.occ('c-b'));
select tests.act_as('carol');
select tests.assert_true(tests.notices('carol', 'points.reversed') = 1, 'A reversal is told too');

-- Cross-Home ----------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_denied(format($$select * from public.create_reward(%L, %L, 'B reward', 5)$$,
  tests.i('r-window'), tests.i('home-b')), 'A reward id of another Home is refused', '22023');
select tests.act_as('dave');
select tests.assert_denied(format('select public.list_rewards(%L)', tests.i('home-a')), 'Non-members see no rewards');
select tests.assert_true(
  (select outcome = 'not_found' from public.redeem_reward(tests.i('red-b'), tests.i('r-ice'), 20)),
  'and cannot redeem them');

-- The cached totals always equal what the ledger and the pending requests say.
select set_config('role', 'postgres', true);
select tests.assert_true(
  not exists (
    select 1 from private.point_accounts a
    where a.balance <> coalesce((select sum(e.amount) from private.point_entries e where e.account_id = a.id), 0)
       or a.reserved <> coalesce((select sum(r.cost) from private.reward_redemptions r
         where r.account_id = a.id and r.status = 'pending'), 0)),
  'Every account''s cached balance and reserved points match its ledger and pending requests');
select tests.assert_true(
  (select count(*) from private.point_accounts) > 0,
  'and the check above covered real accounts');
