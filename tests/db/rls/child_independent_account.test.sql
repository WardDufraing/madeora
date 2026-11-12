-- S42 part 3: a child's move to an independent account
-- (supabase/migrations/20261202090000_child_independent_account.sql). Who may start and cancel it,
-- the age taken from the Homes' countries, the young person's claim and verification through the
-- web server only, and what completion ends and keeps.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
create temporary table tokens (name text primary key, token text not null) on commit drop;
grant all on ids, tokens to anon, authenticated, service_role;

create function tests.ci(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.ci_token(p_name text) returns text
  language sql stable
  as $$ select t.token from pg_temp.tokens t where t.name = p_name $$;

create function tests.ci_mid(p_home uuid, p_user uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select m.id from private.home_memberships_all m where m.home_id = p_home and m.user_id = p_user
  $$;

create function tests.ci_child(p_child_membership uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select m.user_id from private.home_memberships_all m where m.id = p_child_membership $$;

create function tests.ci_hash(p_seed text) returns text
  language sql immutable
  as $$
    select 'scrypt$15$8$1$' || substr(translate(encode(sha256(convert_to('s' || p_seed, 'UTF8')),
             'base64'), '+/=', '-_'), 1, 22)
      || '$' || substr(translate(encode(sha256(convert_to('k' || p_seed, 'UTF8')), 'base64'),
             '+/=', '-_'), 1, 43)
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A (Brussels, age 13) with Bob (Member). She adds Mia, gives her a
-- username and a PIN, and later links her into her own Home C (Amsterdam, age 16).
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob'));
select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values (tests.ci('home-a'), tests.ci('bob'), 'member');
insert into ids values ('m-alice', tests.ci_mid(tests.ci('home-a'), tests.ci('alice'))),
  ('m-bob', tests.ci_mid(tests.ci('home-a'), tests.ci('bob')));
select tests.act_as('alice');
insert into ids select 'm-mia', membership_id from public.create_child(
  tests.ci('home-a'), 'Mia', tests.ci('m-alice'), null, '#16a34a', gen_random_uuid());
insert into ids values ('mia', tests.ci_child(tests.ci('m-mia')));
select public.set_child_username(tests.ci('home-a'), tests.ci('m-mia'), 'mia.k');
select public.set_child_credential(tests.ci('home-a'), tests.ci('m-mia'), 'pin',
  tests.ci_hash('mia-pin'));

-- Guardians start and cancel ---------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_denied(
  format('select * from public.child_transition_state(%L, %L)', tests.ci('home-a'), tests.ci('m-mia')),
  'Someone who is not her guardian sees nothing');
select tests.assert_true(
  (select outcome from public.start_child_transition(tests.ci('home-a'), tests.ci('m-mia'),
     (current_date - interval '15 years')::date)) = 'not_found',
  'and cannot start her move');

select tests.act_as('alice');
select tests.assert_true(
  (select required_age = 13 and can_start and not open
   from public.child_transition_state(tests.ci('home-a'), tests.ci('m-mia'))),
  'In a Belgian Home the age is 13 and her primary guardian may start');
select tests.assert_denied(
  format('select * from public.start_child_transition(%L, %L, %L)', tests.ci('home-a'),
    tests.ci('m-mia'), current_date + 1),
  'A birth date in the future is refused', '22023');
select tests.assert_true(
  (select outcome = 'not_eligible' and eligible_on = (current_date - interval '10 years' + interval '13 years')::date
   from public.start_child_transition(tests.ci('home-a'), tests.ci('m-mia'),
     (current_date - interval '10 years')::date)),
  'A ten-year-old is not eligible yet and her guardian learns when she will be');
select tests.assert_true(
  (select open from public.child_transition_state(tests.ci('home-a'), tests.ci('m-mia'))) = false,
  'Nothing was started');

-- A second Home in the Netherlands raises the age to 16 for all of her Homes.
create temporary table link (code text) on commit drop;
grant all on link to anon, authenticated;
insert into ids select 'home-c', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
insert into link select code from public.create_child_link_code(tests.ci('home-a'), tests.ci('m-mia'));
insert into ids select 'm-mia-c', membership_id from public.redeem_child_link_code(
  tests.ci('home-c'), (select code from link), '#2563eb');
select tests.assert_true(
  (select required_age from public.child_transition_state(tests.ci('home-a'), tests.ci('m-mia'))) = 16,
  'With a Dutch Home too, she needs to be 16');
select tests.assert_true(
  (select outcome from public.start_child_transition(tests.ci('home-a'), tests.ci('m-mia'),
     (current_date - interval '14 years')::date)) = 'not_eligible',
  'So at 14 she is not eligible');
insert into tokens select 'first', token from public.start_child_transition(
  tests.ci('home-a'), tests.ci('m-mia'), (current_date - interval '17 years')::date)
  where outcome = 'started';
insert into tokens select 'claim', token from public.start_child_transition(
  tests.ci('home-a'), tests.ci('m-mia'), (current_date - interval '17 years')::date)
  where outcome = 'started';
select tests.assert_true(tests.ci_token('claim') is not null, 'At 17 her guardian starts the move');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.audit_events e
              where to_jsonb(e)::text like '%' || (current_date - interval '17 years')::date::text || '%'),
  'No audit record holds the birth date');

select tests.act_as('bob');
select tests.assert_true(public.cancel_child_transition(tests.ci('home-a'), tests.ci('m-mia')) = 'not_found',
  'Bob cannot cancel it');

-- Only the web server reaches the young person's steps ---------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(format('select public.child_transition_preview(%L)', tests.ci_token('claim')),
  'A signed-in adult cannot read the claim');
select tests.assert_denied(
  format('select public.claim_child_transition(%L, %L)', tests.ci_token('claim'), 'x@example.org'),
  'nor claim it');
select tests.assert_denied(format('select public.complete_child_transition(%L)', 'x'),
  'nor complete one');
select tests.act_as_anon();
select tests.assert_denied(format('select public.child_transition_preview(%L)', tests.ci_token('claim')),
  'Nor can anyone without a session');

select tests.act_as_service_role();
select tests.assert_true(public.child_transition_preview(tests.ci_token('first')) is null,
  'Restarting replaced the first link');
select tests.assert_true(
  (select p ->> 'name' = 'Mia' and jsonb_array_length(p -> 'homes') = 2
          and (p ->> 'pin_homes')::int = 1 and (p ->> 'has_username')::boolean
          and (p ->> 'guardians')::int = 2
   from public.child_transition_preview(tests.ci_token('claim')) p),
  'The claim shows her name, her two Homes and what will end');
select tests.assert_true(public.claim_child_transition(tests.ci_token('claim'), 'not-an-address')
  = 'invalid_email', 'A malformed address is refused');
select tests.assert_true(public.claim_child_transition(tests.ci_token('claim'), 'ALICE@madeora.test')
  = 'email_taken', 'Another account''s address is refused');
select tests.assert_true(public.claim_child_transition('wrong', 'mia@example.org') = 'invalid',
  'A wrong link is refused');
select tests.assert_true(public.claim_child_transition(tests.ci_token('claim'), ' Mia@Example.org ')
  = 'sent', 'Her own address gets a verification link');

select tests.act_as_owner();
insert into tokens select 'email', e.token from private.security_emails e
  where e.kind = 'transition_verify' and e.to_email = 'mia@example.org' and e.user_id = tests.ci('mia');
select tests.assert_true(tests.ci_token('email') is not null, 'The link goes to the address she gave');
select tests.assert_true(
  (select status from private.child_transitions where child_user_id = tests.ci('mia')
     and status = 'started') is not null
  and private.is_child(tests.ci('mia')),
  'Until she confirms, she is still a guardian-managed child');

select tests.act_as_service_role();
select tests.assert_true(
  (select (r ->> 'completed')::boolean = false and r ->> 'email' = 'mia@example.org'
   from public.child_transition_review(tests.ci_token('email')) r),
  'The emailed link opens the final review');

-- Guardian disagreement: a cancelled move cannot be completed --------------------------------------------

select tests.act_as('alice');
insert into tokens select 'cancelled', tests.ci_token('email');
select tests.assert_true(public.cancel_child_transition(tests.ci('home-c'), tests.ci('m-mia-c'))
  = 'cancelled', 'A guardian cancels the move');
select tests.act_as_service_role();
select tests.assert_true(public.complete_child_transition(tests.ci_token('cancelled')) = 'invalid',
  'Its emailed link no longer works');
select tests.act_as_owner();
select tests.assert_true(private.is_child(tests.ci('mia')), 'She is still a managed child');

-- Restarted and completed -------------------------------------------------------------------------------

select tests.act_as('alice');
delete from tokens where name in ('claim', 'email');
insert into tokens select 'claim', token from public.start_child_transition(
  tests.ci('home-a'), tests.ci('m-mia'), (current_date - interval '17 years')::date);
select tests.act_as_service_role();
select public.claim_child_transition(tests.ci_token('claim'), 'mia@example.org');
select tests.act_as_owner();
insert into tokens select 'email', e.token from private.security_emails e
  where e.kind = 'transition_verify' and e.token <> tests.ci_token('cancelled');

select tests.act_as_service_role();
select tests.assert_true(public.complete_child_transition(tests.ci_token('email')) = 'completed',
  'She confirms and the move completes');
select tests.assert_true(public.complete_child_transition(tests.ci_token('email')) = 'completed',
  'A retry of the same link answers the same and changes nothing');
select tests.assert_true(
  (select (r ->> 'completed')::boolean from public.child_transition_review(tests.ci_token('email')) r),
  'The review says it is done');

select tests.act_as_owner();
select tests.assert_true(not private.is_child(tests.ci('mia')), 'She is no longer a child');
select tests.assert_true(
  (select email = 'mia@example.org' and email_confirmed_at is not null
   from auth.users where id = tests.ci('mia')),
  'Her verified address is her sign-in address, on the same identity');
select tests.assert_true(
  (select count(*) from public.home_memberships where user_id = tests.ci('mia') and role = 'member') = 2,
  'She keeps both Homes as a Member');
select tests.assert_true(
  not exists (select 1 from public.child_guardians where child_user_id = tests.ci('mia'))
  and not exists (select 1 from private.child_credentials where child_user_id = tests.ci('mia'))
  and not exists (select 1 from private.child_home_pins where child_user_id = tests.ci('mia'))
  and not exists (select 1 from public.child_home_settings where child_user_id = tests.ci('mia')),
  'Guardian authority, her username and her child PIN have ended');
select tests.assert_true(
  (select count(*) from private.audit_events
   where action = 'child.transition_completed' and subject_id = tests.ci('mia')) = 2,
  'Completion is audited in each of her Homes');
select tests.assert_true(
  not exists (select 1 from private.audit_events e where to_jsonb(e)::text like '%mia@example.org%'),
  'No audit record holds her address');
select tests.assert_true(private.confirmed_email(tests.ci('mia')) = 'mia@example.org',
  'She now counts as an adult with a confirmed address');

select tests.act_as('alice');
select tests.assert_denied(
  format('select * from public.child_transition_state(%L, %L)', tests.ci('home-a'), tests.ci('m-mia')),
  'Her former guardian has no guardian view any more');
select tests.assert_true(
  (select outcome from public.start_child_transition(tests.ci('home-a'), tests.ci('m-mia'),
     (current_date - interval '17 years')::date)) = 'not_found',
  'and cannot start anything for her');
