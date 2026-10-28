-- S28b: personal points and rewards (supabase/migrations/*_personal_points_rewards.sql). Alice holds a
-- personal ledger with no Home at all. Bob owns Home H; Carol is its Administrator with every points
-- and rewards capability; Dave is a Madeora staff account and belongs to no Home. Later Alice joins
-- Home H as a Member, earns Home points there, and leaves; Home H is then deleted.
-- Covers: nothing reachable as a table or private function; zero Homes is enough; credits,
-- corrections, reversal once, insufficient points, retries; rewards (create, edit with preview,
-- archive, limits: total, per week, window, 200 active); immediate redemption, cost changes,
-- fulfillment, correction with a reason, refund once, replacement; no other account, Home role or
-- staff account reads or changes anything, with forged ids answering exactly like missing ones; an
-- id another account uses never collides; the Home ledger is untouched by personal changes and the
-- personal one by Home changes, leaving and Home deletion; the cached balance matches the ledger.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '36000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now());
insert into private.madeora_staff (user_id, note) values ('36000000-0000-4000-8000-000000000001', 'S28b test');

insert into ids select n, gen_random_uuid() from unnest(array[
  'c-1', 'c-2', 'c-3', 'c-carol', 'r-ice', 'r-week', 'r-window', 'r-once', 'r-carol', 'x-1', 'x-2',
  'x-3', 'x-4', 'x-5', 'x-6', 'x-carol', 'home-reward', 'home-red', 'adj-home'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.bal(p_user text) returns integer
  language sql stable security definer as $$
  select coalesce((select balance from private.personal_point_accounts where user_id = tests.user_id(p_user)), 0); $$;
create function tests.home_bal(p_user text) returns integer
  language sql stable security definer as $$
  select coalesce((select balance from private.point_accounts
    where home_id = tests.i('home-h') and user_id = tests.user_id(p_user)), 0); $$;
create function tests.wrev(p_name text) returns integer
  language sql stable security definer as $$
  select revision from private.personal_rewards where id = tests.i(p_name); $$;
create function tests.xrev(p_name text) returns integer
  language sql stable security definer as $$
  select revision from private.personal_reward_redemptions where id = tests.i(p_name); $$;
create function tests.xstate(p_name text) returns text
  language sql stable security definer as $$
  select fulfillment || ':' || coalesce(resolution, '-') from private.personal_reward_redemptions
  where id = tests.i(p_name); $$;
create function tests.entries(p_user text) returns bigint
  language sql stable security definer as $$
  select count(*) from private.personal_point_entries where user_id = tests.user_id(p_user); $$;
-- Runs a boolean query as the test owner (the private schema is closed to API roles).
create function tests.sd(p_query text) returns boolean
  language plpgsql security definer as $$
  declare v boolean;
  begin execute p_query into v; return v; end $$;
create function tests.sdu(p_query text) returns uuid
  language plpgsql security definer as $$
  declare v uuid;
  begin execute p_query into v; return v; end $$;
create function tests.today() returns date
  language sql stable as $$ select (now() at time zone 'UTC')::date; $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable -----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied($$select * from private.personal_point_accounts$$, 'Accounts are not a table anyone reads');
select tests.assert_denied($$select * from private.personal_point_entries$$, 'The ledger is not a table anyone reads');
select tests.assert_denied($$select * from private.personal_rewards$$, 'Rewards are not a table anyone reads');
select tests.assert_denied($$select * from private.personal_reward_redemptions$$,
  'Redemptions are not a table anyone reads');
select tests.assert_denied($$select * from private.personal_reward_redemption_events$$,
  'Redemption history is not a table anyone reads');
select tests.assert_denied($$select private.personal_totals(auth.uid())$$, 'Private functions are not callable');
select tests.assert_denied($$select private.lock_personal_account(auth.uid())$$, 'Not even the account lock');
select tests.act_as_anon();
select tests.assert_denied($$select public.get_personal_points()$$, 'Anonymous callers get nothing');
select tests.act_as_service_role();
select tests.assert_denied($$select * from private.personal_point_entries$$,
  'The service role cannot read the tables through the API either');

-- Zero Homes: an empty account, then credits ------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  tests.sd($q$select count(*) = 0 from public.home_memberships where user_id = tests.user_id('alice')$q$),
  'Alice starts with no Home');
select tests.assert_true(
  public.get_personal_points() = '{"totals": {"available": 0, "earned": 0, "spent": 0}, "entries": [], "next": null}'::jsonb,
  'With no entries the account reads as zeros');
select tests.assert_denied(format($$select * from public.adjust_personal_points(%L, 'credit', 10, 'ok')$$, tests.i('c-1')),
  'A reason shorter than three characters is refused', '22023');
select tests.assert_denied(format($$select * from public.adjust_personal_points(%L, 'credit', -5, 'Gift to me')$$,
  tests.i('c-1')), 'A credit is positive', '22023');
select tests.assert_denied(format($$select * from public.adjust_personal_points(%L, 'credit', 100001, 'Too many')$$,
  tests.i('c-1')), 'At most 100 000 at once', '22023');
select tests.assert_denied(format($$select * from public.adjust_personal_points(%L, 'bonus', 5, 'Home kind')$$,
  tests.i('c-1')), 'Home entry kinds are not personal ones', '22023');
select tests.assert_true(
  (select outcome = 'preview' and (preview ->> 'availableAfter')::integer = 50
    from public.adjust_personal_points(tests.i('c-1'), 'credit', 50, 'Finished my course', true)),
  'A credit previews the balance after');
select tests.assert_true(tests.entries('alice') = 0, 'and posts nothing');
select tests.assert_true(
  (select outcome = 'posted' and entry_id = tests.i('c-1')
    from public.adjust_personal_points(tests.i('c-1'), 'credit', 50, '  Finished   my course ')),
  'Alice credits herself 50 points with a reason');
select tests.assert_true(
  (select outcome = 'exists' and entry_id = tests.i('c-1')
    from public.adjust_personal_points(tests.i('c-1'), 'credit', 50, 'Finished my course')),
  'A retry with the same id posts nothing');
select tests.assert_true(tests.bal('alice') = 50 and tests.entries('alice') = 1, 'Once: 50 points, one entry');
select tests.assert_true(
  tests.sd($q$select e.reason = 'Finished my course' and e.actor_id = tests.user_id('alice')
    and e.available_before = 0 and e.available_after = 50 from private.personal_point_entries e
    where e.id = tests.i('c-1')$q$),
  'The entry stores the reason, the actor and the balances before and after');
select tests.assert_true(
  (select outcome = 'insufficient_points' and (preview ->> 'availableAfter')::integer = -10
    from public.adjust_personal_points(tests.i('c-2'), 'correction', -60, 'Counted twice')),
  'A correction never takes the balance below zero');
select tests.assert_true(
  (select outcome = 'posted' from public.adjust_personal_points(tests.i('c-2'), 'correction', -5, 'Counted twice')),
  'A negative correction within the balance posts');
select tests.assert_true(
  (select outcome = 'posted' from public.adjust_personal_points(tests.i('c-3'), 'credit', 20, 'Ran 10 km')),
  'Another credit');
select tests.assert_true(tests.bal('alice') = 65, 'Balance 50 - 5 + 20');

-- Reversal once
select tests.assert_true(
  (select outcome = 'preview' and (preview ->> 'availableAfter')::integer = 45
    from public.reverse_personal_point_entry(tests.i('c-3'), 'Not really 10 km', true)),
  'A reversal previews');
select tests.assert_true(
  (select outcome = 'reversed' from public.reverse_personal_point_entry(tests.i('c-3'), 'Not really 10 km')),
  'and reverses the credit');
select tests.assert_true(
  (select outcome = 'already_reversed' from public.reverse_personal_point_entry(tests.i('c-3'), 'Again please')),
  'only once');
select tests.assert_true(
  (select outcome = 'not_reversible' from public.reverse_personal_point_entry(
    tests.sdu($q$select id from private.personal_point_entries where reverses_id = tests.i('c-3')$q$),
    'Undo the undo')),
  'A reversal itself is not reversible');
select tests.assert_true(tests.bal('alice') = 45, 'Balance after the reversal');
select tests.assert_true(
  (select (public.get_personal_points() -> 'totals') = '{"available": 45, "earned": 45, "spent": 0}'::jsonb),
  'Earned counts credits, corrections and reversals');
select tests.assert_true(
  (select jsonb_array_length(public.get_personal_points() -> 'entries') = 4
    and (public.get_personal_points() -> 'entries' -> 0 ->> 'kind') = 'manual_reversal'),
  'The ledger lists every entry, newest first');
select tests.assert_true(
  (select jsonb_array_length(public.get_personal_points(null, 2) -> 'entries') = 2
    and (public.get_personal_points(null, 2) ->> 'next') is not null),
  'and pages');

-- Rewards -----------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_personal_reward(tests.i('r-ice'), 'Ice cream', 30,
    'A big one')),
  'Alice defines a reward');
select tests.assert_true(
  (select outcome = 'exists' from public.create_personal_reward(tests.i('r-ice'), 'Ice cream', 30)),
  'A retry creates nothing');
select tests.assert_true(
  (select outcome = 'created' from public.create_personal_reward(tests.i('r-week'), 'Cinema', 5,
    p_period_limit => 1, p_limit_period => 'week')),
  'A reward once a week');
select tests.assert_true(
  (select outcome = 'created' from public.create_personal_reward(tests.i('r-window'), 'Spa day', 1,
    p_available_from => tests.today() + 5)),
  'A reward from a later date');
select tests.assert_true(
  (select outcome = 'created' from public.create_personal_reward(tests.i('r-once'), 'Concert', 1,
    p_total_limit => 1)),
  'A reward with a total limit of one');
select tests.assert_denied(format($$select * from public.create_personal_reward(%L, ' ', 5)$$, tests.i('x-1')),
  'A blank name is refused', '22023');
select tests.assert_denied(format($$select * from public.create_personal_reward(%L, 'Free', 0)$$, tests.i('x-1')),
  'A reward costs at least 1', '22023');
select tests.assert_denied(format($$select * from public.create_personal_reward(%L, 'Half', 5, p_period_limit => 1)$$,
  tests.i('x-1')), 'A period limit needs its period', '22023');
select tests.assert_true(
  (select jsonb_array_length(public.list_personal_rewards(false, tests.today(), 'monday')) = 4),
  'The catalog lists the four rewards');
select tests.assert_true(
  (select r ->> 'block' = 'not_started' from jsonb_array_elements(public.list_personal_rewards(false, tests.today()))
    r where r ->> 'id' = tests.i('r-window')::text),
  'A reward before its window says so');
select tests.assert_denied($$select public.list_personal_rewards(false, null, 'tuesday')$$,
  'An unknown week start is refused', '22023');

-- Redemption
select tests.assert_true(
  (select outcome = 'preview' and (detail ->> 'availableAfter')::integer = 15
    from public.redeem_personal_reward(tests.i('x-1'), tests.i('r-ice'), 30, true, tests.today())),
  'Redeeming previews the cost and the balance after');
select tests.assert_true(
  (select outcome = 'cost_changed' from public.redeem_personal_reward(tests.i('x-1'), tests.i('r-ice'), 25)),
  'A cost the owner did not see is refused');
select tests.assert_true(
  (select outcome = 'redeemed' from public.redeem_personal_reward(tests.i('x-1'), tests.i('r-ice'), 30)),
  'Alice redeems Ice cream');
select tests.assert_true(
  (select outcome = 'exists' from public.redeem_personal_reward(tests.i('x-1'), tests.i('r-ice'), 30)),
  'A retry charges nothing more');
select tests.assert_true(tests.bal('alice') = 15 and tests.xstate('x-1') = 'pending:-',
  'Charged once, pending fulfillment');
select tests.assert_true(
  (select outcome = 'insufficient_points' from public.redeem_personal_reward(tests.i('x-2'), tests.i('r-ice'), 30)),
  'Not enough points left: nothing partial');
select tests.assert_true(
  (select outcome = 'redeemed' from public.redeem_personal_reward(tests.i('x-2'), tests.i('r-week'), 5,
    false, tests.today(), 'monday')),
  'The weekly reward once');
select tests.assert_true(
  (select outcome = 'period_limit' and (detail ->> 'nextEligibleOn')::date
      = tests.today() - ((extract(isodow from tests.today())::integer + 6) % 7) + 7
    from public.redeem_personal_reward(tests.i('x-3'), tests.i('r-week'), 5, false, tests.today(), 'monday')),
  'but not twice in the same week, with the next eligible date');
select tests.assert_true(
  (select outcome = 'not_started' from public.redeem_personal_reward(tests.i('x-3'), tests.i('r-window'), 1)),
  'A reward before its window cannot be redeemed');
select tests.assert_true(
  (select outcome = 'redeemed' from public.redeem_personal_reward(tests.i('x-3'), tests.i('r-once'), 1)),
  'The total-limited reward once');
select tests.assert_true(
  (select outcome = 'sold_out' from public.redeem_personal_reward(tests.i('x-4'), tests.i('r-once'), 1)),
  'then it is used up');

-- Edit with preview, archive
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'redeemed')::integer = 1 and (impact ->> 'costChanged')::boolean
    from public.update_personal_reward(tests.i('r-ice'), tests.wrev('r-ice'), 'Ice cream', 40, p_dry_run => true)),
  'An edit previews its impact');
select tests.assert_true(
  (select outcome = 'saved' from public.update_personal_reward(tests.i('r-ice'), tests.wrev('r-ice'), 'Ice cream XL', 40)),
  'and saves');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_personal_reward(tests.i('r-ice'), 1, 'Ice cream', 30)),
  'A stale revision is a conflict');
select tests.assert_true(
  tests.sd($q$select cost = 30 and reward_name = 'Ice cream' from private.personal_reward_redemptions
    where id = tests.i('x-1')$q$),
  'A past redemption keeps its cost and name');
select tests.assert_true(
  (select outcome = 'saved' from public.archive_personal_reward(tests.i('r-window'), tests.wrev('r-window'), true)),
  'Archiving a reward');
select tests.assert_true(
  (select jsonb_array_length(public.list_personal_rewards()) = 3
    and jsonb_array_length(public.list_personal_rewards(true)) = 4),
  'hides it from the catalog and keeps it');
select tests.assert_true(
  (select outcome = 'archived' from public.redeem_personal_reward(tests.i('x-4'), tests.i('r-window'), 1)),
  'An archived reward cannot be redeemed');

-- Fulfillment, refund once, replacement
select tests.assert_true(
  (select outcome = 'not_unable' from public.resolve_personal_reward_redemption(tests.i('x-1'), tests.xrev('x-1'),
    'refund')),
  'Only Unable to fulfill can be resolved');
select tests.assert_true(
  (select outcome = 'saved' from public.set_personal_reward_fulfillment(tests.i('x-1'), tests.xrev('x-1'), 'unable')),
  'Ice cream could not be given');
select tests.assert_true(
  (select outcome = 'reason_required' from public.set_personal_reward_fulfillment(tests.i('x-1'), tests.xrev('x-1'),
    'fulfilled')),
  'A correction needs a reason');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'availableAfter')::integer = tests.bal('alice') + 30
    from public.resolve_personal_reward_redemption(tests.i('x-1'), tests.xrev('x-1'), 'refund', p_dry_run => true)),
  'A refund previews the balance after');
select tests.assert_true(
  (select outcome = 'resolved' from public.resolve_personal_reward_redemption(tests.i('x-1'), tests.xrev('x-1'),
    'refund', 'Shop was closed')),
  'Refunded');
select tests.assert_true(
  (select outcome = 'already_resolved' from public.resolve_personal_reward_redemption(tests.i('x-1'),
    tests.xrev('x-1'), 'refund')),
  'only once');
select tests.assert_true(
  (select outcome = 'already_resolved' from public.set_personal_reward_fulfillment(tests.i('x-1'), tests.xrev('x-1'),
    'fulfilled', 'Changed my mind')),
  'A resolved case is final');
select tests.assert_true(tests.xstate('x-1') = 'unable:refund' and tests.bal('alice') = 39,
  'Refunded: 45 - 30 - 5 - 1 + 30');
select tests.assert_true(
  tests.sd($q$select count(*) = 1 from private.personal_point_entries where redemption_id = tests.i('x-1')
    and kind = 'refund'$q$),
  'One linked refund entry');
select public.set_personal_reward_fulfillment(tests.i('x-2'), tests.xrev('x-2'), 'unable');
select tests.assert_denied(format($$select * from public.resolve_personal_reward_redemption(%L, %s, 'replacement')$$,
  tests.i('x-2'), tests.xrev('x-2')), 'A replacement says what instead', '22023');
select tests.assert_true(
  (select outcome = 'resolved' from public.resolve_personal_reward_redemption(tests.i('x-2'), tests.xrev('x-2'),
    'replacement', p_replacement => 'A film at home')),
  'A replacement resolves without charging again');
select tests.assert_true(tests.bal('alice') = 39 and tests.xstate('x-2') = 'unable:replacement', 'Balance unchanged');
select tests.assert_true(
  (select outcome = 'saved' from public.set_personal_reward_fulfillment(tests.i('x-3'), tests.xrev('x-3'), 'fulfilled')),
  'The concert was given');
select tests.assert_true(
  (select jsonb_array_length(public.list_personal_reward_redemptions('all')) = 3
    and jsonb_array_length(public.list_personal_reward_redemptions('open')) = 0),
  'Three redemptions, none open');
select tests.assert_true(
  (select (public.get_personal_points() -> 'totals') = '{"available": 39, "earned": 45, "spent": 6}'::jsonb),
  'Spent counts redemptions less refunds');
select tests.assert_true(
  tests.sd($q$select count(*) = 0 from private.audit_events where subject_id in (
    select id from ids)$q$),
  'Nothing personal is written to the Home audit log');
select tests.act_as_owner();
select tests.assert_denied(format($$update private.personal_point_entries set amount = 1000 where id = %L$$,
  tests.i('c-1')), 'The ledger is append-only, even for the database owner');

-- 200 active rewards
insert into private.personal_rewards (user_id, id, name, cost)
  select tests.user_id('alice'), gen_random_uuid(), 'Bulk ' || g, 1 from generate_series(1, 197) g;
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'limit_reached' from public.create_personal_reward(tests.i('x-5'), 'One too many', 1)),
  'At most 200 active rewards');
select tests.assert_true(
  (select outcome = 'limit_reached' from public.archive_personal_reward(tests.i('r-window'), tests.wrev('r-window'),
    false)),
  'Restoring one counts too');
select tests.act_as_owner();
delete from private.personal_rewards where name like 'Bulk %';

-- Nobody else ---------------------------------------------------------------------------------------------------

select tests.act_as('bob');
insert into ids select 'home-h', public.create_home('Huis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.i('home-h'), tests.user_id('carol'), 'administrator');
insert into ids select 'm-carol', id from public.home_memberships
  where home_id = tests.i('home-h') and user_id = tests.user_id('carol');
create temporary table snapshot on commit drop as
  select (select count(*) from private.personal_point_entries) as entries,
    (select count(*) from private.personal_rewards) as rewards,
    (select count(*) from private.personal_reward_redemptions) as redemptions,
    tests.bal('alice') as balance;
grant all on snapshot to authenticated;
select tests.act_as('bob');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-h'), tests.i('m-carol'),
    array['manageHomePoints', 'manageHomeRewards', 'approveHomeRewards']) = 'ok',
  'Carol holds every points and rewards capability in Home H');

-- Bob (a Home Owner), Carol (an Administrator with every points capability) and Dave (staff, no Home)
do $$
declare
  v_name text;
begin
  foreach v_name in array array['bob', 'carol', 'dave'] loop
    perform tests.act_as(v_name);
    if public.get_personal_points() -> 'totals' <> '{"available": 0, "earned": 0, "spent": 0}'::jsonb
       or jsonb_array_length(public.get_personal_points() -> 'entries') <> 0 then
      raise exception 'S28b: % sees a personal balance', v_name using errcode = 'MT001';
    end if;
    if jsonb_array_length(public.list_personal_rewards(true)) <> 0
       or jsonb_array_length(public.list_personal_reward_redemptions('all')) <> 0 then
      raise exception 'S28b: % sees personal rewards', v_name using errcode = 'MT001';
    end if;
    if (select outcome from public.reverse_personal_point_entry(tests.i('c-1'), 'Not yours')) <> 'not_found'
       or (select outcome from public.update_personal_reward(tests.i('r-ice'), 2, 'Mine now', 1)) <> 'not_found'
       or (select outcome from public.archive_personal_reward(tests.i('r-ice'), 2, true)) <> 'not_found'
       or (select outcome from public.redeem_personal_reward(tests.i('x-6'), tests.i('r-ice'), 40)) <> 'not_found'
       or (select outcome from public.set_personal_reward_fulfillment(tests.i('x-3'), 2, 'unable')) <> 'not_found'
       or (select outcome from public.resolve_personal_reward_redemption(tests.i('x-2'), 3, 'refund')) <> 'not_found'
    then
      raise exception 'S28b: % reaches Alice''s ledger (expected not_found everywhere)', v_name using errcode = 'MT001';
    end if;
  end loop;
end
$$;
select tests.assert_true(
  tests.sd($q$select (select count(*) from private.personal_point_entries) = s.entries
    and (select count(*) from private.personal_rewards) = s.rewards
    and (select count(*) from private.personal_reward_redemptions) = s.redemptions
    and tests.bal('alice') = s.balance from snapshot s$q$),
  'Nobody else changed anything in Alice''s ledger');

-- An id Alice uses is free for anyone else: nothing tells them it exists.
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'posted' from public.adjust_personal_points(tests.i('c-1'), 'credit', 7, 'My own points')),
  'Carol posts to her own ledger with an id Alice also uses');
select tests.assert_true(
  (select outcome = 'created' from public.create_personal_reward(tests.i('r-ice'), 'Book', 7)),
  'and a reward with the id of Alice''s');
select tests.assert_true(
  (select outcome = 'redeemed' from public.redeem_personal_reward(tests.i('x-1'), tests.i('r-ice'), 7)),
  'and redeems it with the id of Alice''s redemption');
select tests.assert_true(tests.bal('carol') = 0 and tests.bal('alice') = 39, 'Each balance is its own');
select tests.assert_true(
  (select array_agg((e ->> 'seq')::integer order by (e ->> 'seq')::integer)
    from jsonb_array_elements(public.get_personal_points() -> 'entries') e) = array[1, 2],
  'Carol''s entries are numbered from 1, so the numbers reveal nothing about other ledgers');
select tests.assert_true(
  (select jsonb_array_length(public.list_personal_rewards()) = 1
    and public.list_personal_rewards() -> 0 ->> 'name' = 'Book'),
  'Carol sees only her own reward');
-- A Home function cannot see a personal reward either.
select tests.assert_true(
  (select outcome = 'not_found' from public.redeem_reward(gen_random_uuid(), tests.i('r-ice'), 7)),
  'The Home redeem function does not find a personal reward');
select tests.assert_true(
  (select jsonb_array_length(public.list_rewards(tests.i('home-h'), true)) = 0),
  'and the Home catalog shows none');

-- Personal and Home ledgers stay apart --------------------------------------------------------------------------

select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.i('home-h'), tests.user_id('alice'), 'member');
insert into ids select 'm-alice', id from public.home_memberships
  where home_id = tests.i('home-h') and user_id = tests.user_id('alice');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'posted' from public.adjust_points(tests.i('adj-home'), tests.i('home-h'), tests.i('m-alice'),
    'bonus', 11, 'Helped a lot')),
  'Carol gives Alice 11 Home points');
select tests.assert_true(
  not exists (select 1 from public.list_point_accounts(tests.i('home-h')) a where (a.totals ->> 'available')::integer = 39),
  'The Home account list never shows the personal balance');
select tests.act_as('alice');
select tests.assert_true(tests.home_bal('alice') = 11 and tests.bal('alice') = 39,
  'Alice has 11 Home points and 39 personal points');
select tests.assert_true(
  (public.get_point_summary(tests.i('home-h')) -> 'totals' ->> 'available')::integer = 11,
  'The Home summary shows only the Home balance');
select tests.assert_true(
  (public.get_personal_points() -> 'totals' ->> 'available')::integer = 39,
  'and the personal summary only the personal one');
select public.adjust_personal_points(gen_random_uuid(), 'credit', 100, 'Personal milestone');
select public.redeem_personal_reward(gen_random_uuid(), tests.i('r-ice'), 40);
select tests.assert_true(tests.home_bal('alice') = 11, 'A personal credit and redemption leave the Home balance alone');
select tests.assert_true(public.leave_home(tests.i('home-h')) = 'left', 'Alice leaves the Home');
select tests.assert_true(tests.bal('alice') = 99, 'Leaving the Home leaves her personal ledger in place (39 + 100 - 40)');
select tests.act_as_owner();
delete from public.homes where id = tests.i('home-h');
select tests.assert_true(tests.bal('alice') = 99 and tests.entries('alice') = 10,
  'Deleting a Home leaves the personal ledger in place');

-- The cached balance always equals the ledger.
select tests.assert_true(
  not exists (select 1 from private.personal_point_accounts a
    where a.balance <> coalesce((select sum(e.amount) from private.personal_point_entries e
      where e.user_id = a.user_id), 0)),
  'Every cached balance matches its ledger');
select tests.assert_true(
  not exists (select 1 from information_schema.columns
    where table_schema = 'private' and table_name like 'personal\_%' and column_name = 'home_id'),
  'No personal table has a home_id');
