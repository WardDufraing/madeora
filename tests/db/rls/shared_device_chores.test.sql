-- S42 part 2: chores completed on an approved household device
-- (supabase/migrations/20261201090000_shared_device_chores.sql). Attribution to the selected
-- member, children only for their own chores, the Home's PIN rule, adult and child PINs, Undo, and
-- that acting for a member lasts for one call only.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated, service_role;

create function tests.sd(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.sd_mid(p_home uuid, p_user uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select m.id from private.home_memberships_all m where m.home_id = p_home and m.user_id = p_user
  $$;

create function tests.sd_child(p_child_membership uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select m.user_id from private.home_memberships_all m where m.id = p_child_membership $$;

create function tests.sd_hash(p_seed text) returns text
  language sql immutable
  as $$
    select 'scrypt$15$8$1$' || substr(translate(encode(sha256(convert_to('s' || p_seed, 'UTF8')),
             'base64'), '+/=', '-_'), 1, 22)
      || '$' || substr(translate(encode(sha256(convert_to('k' || p_seed, 'UTF8')), 'base64'),
             '+/=', '-_'), 1, 43)
  $$;

create function tests.sd_key(p_seed text) returns text
  language sql immutable
  as $$ select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex') $$;

create function tests.sd_today() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date $$;

create function tests.sd_occ(p_id uuid)
returns table (status text, completed_by uuid, contributor_id uuid)
  language sql stable security definer set search_path = ''
  as $$ select o.status, o.completed_by, o.contributor_id from private.chore_occurrences o
        where o.id = p_id $$;

create function tests.sd_actors() returns bigint
  language sql stable security definer set search_path = ''
  as $$ select count(*) from private.device_actors $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A with Bob (Member). Alice adds Mia (child) with a PIN in Home A and
-- approves a kitchen device. Chores: one for Mia, one for Bob, one unassigned.
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob'));
select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values (tests.sd('home-a'), tests.sd('bob'), 'member');
insert into ids values ('m-alice', tests.sd_mid(tests.sd('home-a'), tests.sd('alice'))),
  ('m-bob', tests.sd_mid(tests.sd('home-a'), tests.sd('bob')));
select tests.act_as('alice');
insert into ids select 'm-mia', membership_id from public.create_child(
  tests.sd('home-a'), 'Mia', tests.sd('m-alice'), null, '#16a34a', gen_random_uuid());
insert into ids values ('mia', tests.sd_child(tests.sd('m-mia')));
select public.set_child_credential(tests.sd('home-a'), tests.sd('m-mia'), 'pin',
  tests.sd_hash('mia-pin'));
insert into ids select 'device', device_id from public.approve_household_device(
  tests.sd('home-a'), 'Kitchen', tests.sd_key('device'));
insert into ids values ('c-mia', gen_random_uuid()), ('c-bob', gen_random_uuid()),
  ('c-any', gen_random_uuid()), ('c-any2', gen_random_uuid());
insert into ids select 'o-mia', occurrence_id from public.create_chore(tests.sd('c-mia'),
  tests.sd('home-a'), 'Feed the cat',
  jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.sd('m-mia'))),
  p_due_date => tests.sd_today());
insert into ids select 'o-bob', occurrence_id from public.create_chore(tests.sd('c-bob'),
  tests.sd('home-a'), 'Bins',
  jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.sd('m-bob'))),
  p_due_date => tests.sd_today());
insert into ids select 'o-any', occurrence_id from public.create_chore(tests.sd('c-any'),
  tests.sd('home-a'), 'Dishes', '{"mode": "none", "members": []}', p_due_date => tests.sd_today());
insert into ids select 'o-any2', occurrence_id from public.create_chore(tests.sd('c-any2'),
  tests.sd('home-a'), 'Laundry', '{"mode": "none", "members": []}', p_due_date => tests.sd_today());
select tests.assert_true(tests.sd('o-mia') is not null and tests.sd('o-any2') is not null,
  'Fixture: chores for Mia, Bob and nobody');

-- Only the web server reaches the device functions ------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  $$select public.shared_device_board(tests.sd_key('device'))$$,
  'A signed-in member cannot read the device board');
select tests.assert_denied(
  $$select * from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-any'),
      tests.sd('m-bob'), false, tests.sd_key('c'))$$,
  'Nor complete in someone else''s name');

-- The board ---------------------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(public.shared_device_board(tests.sd_key('unknown')) is null,
  'An unknown device sees nothing');
select tests.assert_true(
  (select jsonb_array_length(b -> 'members') = 3 and jsonb_array_length(b -> 'chores') = 4
     and not (b ->> 'require_pin')::boolean
   from (select public.shared_device_board(tests.sd_key('device')) b) x),
  'An approved device sees the Home''s members and today''s open chores');
select tests.assert_true(
  (select (m ->> 'is_child')::boolean and (m ->> 'has_pin')::boolean
   from jsonb_array_elements(public.shared_device_board(tests.sd_key('device')) -> 'members') m
   where (m ->> 'membership_id')::uuid = tests.sd('m-mia')),
  'Mia shows as a child with a PIN for this Home');
select tests.assert_true(
  public.shared_device_board(tests.sd_key('device'))::text not like '%scrypt%',
  'The board never carries a PIN hash');

-- Attributed completions ------------------------------------------------------------------------------------

insert into ids select 'a-any', action_id from public.shared_device_attempt(
  tests.sd_key('device'), tests.sd('o-any'), tests.sd('m-bob'), false, tests.sd_key('c1'))
  where outcome = 'completed' and check_id is null;
select tests.assert_true(tests.sd('a-any') is not null,
  'Bob completes the dishes on the device without a PIN (the Home does not require one)');
select tests.assert_true(
  (select status = 'completed' and completed_by = tests.sd('bob') and contributor_id = tests.sd('bob')
   from tests.sd_occ(tests.sd('o-any'))),
  'The completion is Bob''s, as if he had done it on his own device');
select tests.assert_true(tests.sd_actors() = 0, 'Nobody is left acting for Bob afterwards');
select tests.act_as_owner();
select tests.assert_true(
  (select details ->> 'verification' = 'attributed' and details ? 'device_id'
   from private.audit_events where action = 'chore_occurrence.device_completed'
     and subject_id = tests.sd('o-any')),
  'The audit records the device and that the completion was attributed, not verified');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-any'),
     tests.sd('m-bob'), false, tests.sd_key('c1'))) = 'already_completed',
  'A second tap completes nothing twice');
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-bob'),
     tests.sd('m-mia'), false, tests.sd_key('c1'))) = 'not_eligible',
  'A child cannot be named for someone else''s chore');
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-any2'),
     tests.sd('m-mia'), false, tests.sd_key('c1'))) = 'not_eligible',
  'Nor for unassigned work');
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('elsewhere'), tests.sd('o-any2'),
     tests.sd('m-bob'), false, tests.sd_key('c1'))) = 'device_not_approved',
  'An unapproved device completes nothing');

-- Undo -------------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.reopen_chore_occurrence(tests.sd('o-any'))) = 'not_permitted',
  'Bob himself may not reopen chores');
select tests.act_as_service_role();
select tests.assert_true(
  public.shared_device_undo(tests.sd_key('elsewhere'), tests.sd('a-any')) = 'invalid',
  'Undo works only on the device that completed it');
select tests.assert_true(
  public.shared_device_undo(tests.sd_key('device'), tests.sd('a-any')) = 'undone',
  'The device undoes its own completion');
select tests.assert_true((select status from tests.sd_occ(tests.sd('o-any'))) = 'open',
  'The dishes are open again');
select tests.assert_true(
  public.shared_device_undo(tests.sd_key('device'), tests.sd('a-any')) = 'invalid',
  'An action is undone once');
select tests.assert_true(tests.sd_actors() = 0, 'Undo leaves nobody acting either');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.reopen_chore_occurrence(tests.sd('o-bob'))) = 'not_permitted',
  'The Undo grant ended with that call');
select tests.act_as_owner();
update private.shared_device_actions set created_at = now() - interval '3 minutes';
select tests.act_as_service_role();
insert into ids select 'a-any-2', action_id from public.shared_device_attempt(
  tests.sd_key('device'), tests.sd('o-any'), tests.sd('m-bob'), false, tests.sd_key('c1'));
select tests.act_as_owner();
update private.shared_device_actions set created_at = now() - interval '3 minutes'
  where id = tests.sd('a-any-2');
select tests.act_as_service_role();
select tests.assert_true(
  public.shared_device_undo(tests.sd_key('device'), tests.sd('a-any-2')) = 'expired',
  'Undo is possible for two minutes only');
select tests.act_as_owner();
update private.shared_device_actions set created_at = now() where id = tests.sd('a-any-2');
update private.chore_occurrences set revision = revision + 1 where id = tests.sd('o-any');
select tests.act_as_service_role();
select tests.assert_true(
  public.shared_device_undo(tests.sd_key('device'), tests.sd('a-any-2')) = 'invalid',
  'Undo is refused once someone else changed the chore (say, approved it)');
select tests.assert_true((select status from tests.sd_occ(tests.sd('o-any'))) = 'completed',
  'Their change stands');

-- A child completes their own chore ---------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'completed'
   from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-mia'), tests.sd('m-mia'),
     false, tests.sd_key('c2'))),
  'Mia completes her own chore on the device');
select tests.assert_true(
  (select completed_by = tests.sd('mia') from tests.sd_occ(tests.sd('o-mia'))),
  'It is attributed to Mia');

-- The Home requires a PIN -----------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  public.set_shared_device_pin_rule(tests.sd('home-a'), true) = 'not_permitted',
  'A Member cannot change the Home''s rule');
select tests.act_as('alice');
select tests.assert_true(public.set_shared_device_pin_rule(tests.sd('home-a'), true) = 'saved',
  'The Owner requires a PIN for device completions');
select tests.assert_true(public.shared_device_pin_rule(tests.sd('home-a')),
  'The rule reads back');

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-bob'),
     tests.sd('m-bob'), false, tests.sd_key('c3'))) = 'pin_required',
  'Without a PIN nothing is completed once the Home requires one');
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-bob'),
     tests.sd('m-bob'), true, tests.sd_key('c3'))) = 'pin_not_set',
  'Without a PIN of his own Bob is sent to his own device instead');
select tests.assert_true((select status from tests.sd_occ(tests.sd('o-bob'))) = 'open',
  'Nothing was completed');

select tests.act_as('bob');
select tests.assert_true(public.set_my_device_pin(tests.sd_hash('bob-pin')) = 'saved',
  'Bob sets his own household-device PIN');
select tests.assert_true((select has_pin from public.my_device_pin()), 'He sees that it is set');

select tests.act_as_service_role();
insert into ids select 'chk-bob', check_id from public.shared_device_attempt(
  tests.sd_key('device'), tests.sd('o-bob'), tests.sd('m-bob'), true, tests.sd_key('c3'))
  where outcome = 'check' and pin_hash = tests.sd_hash('bob-pin');
select tests.assert_true(tests.sd('chk-bob') is not null,
  'The server gets Bob''s hash to compare, bound to one check');
select tests.assert_true((select status from tests.sd_occ(tests.sd('o-bob'))) = 'open',
  'Nothing is completed before the PIN matched');
select tests.assert_true(
  (select outcome from public.shared_device_verified(tests.sd_key('elsewhere'), tests.sd('chk-bob')))
    = 'invalid',
  'A check is only good on its own device');
select tests.assert_true(
  (select outcome from public.shared_device_verified(tests.sd_key('device'), tests.sd('chk-bob')))
    = 'completed',
  'After the match the chore is completed');
select tests.assert_true(
  (select outcome from public.shared_device_verified(tests.sd_key('device'), tests.sd('chk-bob')))
    = 'invalid',
  'A check is used once');
select tests.act_as_owner();
select tests.assert_true(
  (select details ->> 'verification' = 'pin'
   from private.audit_events where action = 'chore_occurrence.device_completed'
     and subject_id = tests.sd('o-bob')),
  'The audit records a PIN-verified completion');
select tests.assert_true(
  not exists (select 1 from private.audit_events e
              where to_jsonb(e)::text like '%scrypt%'),
  'No audit record holds a PIN hash');

-- Wrong PINs lock the adult PIN as they lock a child's.
select tests.act_as_service_role();
select public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-any2'), tests.sd('m-bob'),
  true, tests.sd_key('w' || g)) from generate_series(1, 5) g;
select tests.assert_true(
  (select outcome = 'locked' and locked_until > now()
   from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-any2'), tests.sd('m-bob'),
     true, tests.sd_key('w6'))),
  'Five unmatched checks lock Bob''s PIN');

-- Children cannot set an adult PIN.
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from private.member_device_pins where user_id = tests.sd('mia')) = 0,
  'Mia has no adult PIN');
select tests.act_as_user(tests.sd('mia'));
select tests.assert_denied(
  format('select public.set_my_device_pin(%L)', tests.sd_hash('mia-pin')),
  'A child cannot set an adult household-device PIN');

-- Bob removes his PIN; removing it again changes nothing.
select tests.act_as('bob');
select tests.assert_true(public.set_my_device_pin() = 'cleared', 'Bob removes his PIN');
select tests.assert_true(public.set_my_device_pin() = 'unchanged', 'Removing it twice is a no-op');
select tests.assert_true(not (select has_pin from public.my_device_pin()), 'He sees it is gone');

-- Stricter rules per member and per chore (the stricter rule wins) -----------------------------------

select tests.act_as('alice');
select public.set_shared_device_pin_rule(tests.sd('home-a'), false);
insert into ids values ('c-rule', gen_random_uuid()), ('c-rule2', gen_random_uuid());
insert into ids select 'o-rule', occurrence_id from public.create_chore(tests.sd('c-rule'),
  tests.sd('home-a'), 'Windows', '{"mode": "none", "members": []}', p_due_date => tests.sd_today());
insert into ids select 'o-rule2', occurrence_id from public.create_chore(tests.sd('c-rule2'),
  tests.sd('home-a'), 'Plants', '{"mode": "none", "members": []}', p_due_date => tests.sd_today());

select tests.act_as('bob');
select tests.assert_denied(format('select public.shared_device_pin_targets(%L)', tests.sd('home-a')),
  'A plain Member cannot read the PIN rules');
select tests.assert_true(
  public.set_shared_device_pin_target(tests.sd('home-a'), 'member', tests.sd('m-bob'), false)
    = 'not_permitted',
  'nor change them, even for himself');

select tests.act_as('alice');
select tests.assert_true(
  public.set_shared_device_pin_target(tests.sd('home-a'), 'member', tests.sd('m-alice'), true)
    = 'saved',
  'The Owner makes herself always confirm with her PIN');
select tests.assert_true(
  public.set_shared_device_pin_target(tests.sd('home-a'), 'chore', tests.sd('c-rule2'), true)
    = 'saved',
  'and the plants always need a PIN');
select tests.assert_true(
  public.set_shared_device_pin_target(tests.sd('home-a'), 'chore', tests.sd('c-rule2'), true)
    = 'unchanged',
  'Saving the same rule again changes nothing');
select tests.assert_true(
  public.set_shared_device_pin_target(tests.sd('home-a'), 'chore', gen_random_uuid(), true)
    = 'not_found',
  'A chore of another Home or none at all is not found');
select tests.assert_true(
  (select (t -> 'members') @> jsonb_build_array(jsonb_build_object(
            'membership_id', tests.sd('m-alice'), 'required', true))
          and (t -> 'chores') @> jsonb_build_array(jsonb_build_object(
            'chore_id', tests.sd('c-rule2'), 'required', true))
   from public.shared_device_pin_targets(tests.sd('home-a')) t),
  'The managers see which members and chores need the PIN');

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-rule'),
     tests.sd('m-alice'), false, tests.sd_key('c9'))) = 'pin_required',
  'Alice''s own rule asks for her PIN on any chore');
select tests.assert_true(
  (select outcome from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-rule2'),
     tests.sd('m-bob'), false, tests.sd_key('c9'))) = 'pin_required',
  'The plants need a PIN whoever does them');
select tests.assert_true(
  (select status from tests.sd_occ(tests.sd('o-rule2'))) = 'open',
  'Nothing was completed without it');
select tests.assert_true(
  (select (b -> 'chores') @> jsonb_build_array(jsonb_build_object(
            'occurrence_id', tests.sd('o-rule2'), 'requires_pin', true))
          and (b -> 'members') @> jsonb_build_array(jsonb_build_object(
            'membership_id', tests.sd('m-alice'), 'requires_pin', true))
   from public.shared_device_board(tests.sd_key('device')) b),
  'The device knows in advance which chores and people need the PIN');
select tests.assert_true(
  (select outcome = 'completed'
   from public.shared_device_attempt(tests.sd_key('device'), tests.sd('o-rule'),
     tests.sd('m-bob'), false, tests.sd_key('c9'))),
  'Without any rule for Bob or the windows, naming him is enough');
