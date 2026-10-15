-- S12b: verified Home ownership recovery (supabase/migrations/*_ownership_recovery.sql).
-- Home A: Alice is the Owner; Dave (Administrator) and Erin (Member) joined 40 days ago, Finn
-- (Member) 5 days ago. Home B: Bob is the Owner; Carol (Member) and Gina (Administrator) joined 40
-- days ago. Sam is Madeora staff and a member of no Home. Everything goes through the public
-- functions; cases, objections, appeals and the staff list are out of the API's reach.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'erin@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'finn@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'gina@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000005',
   'authenticated', 'authenticated', 'sam@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Elders', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role, created_at) values
  ((select id from ids where name = 'home-a'), tests.user_id('dave'), 'administrator', now() - interval '40 days'),
  ((select id from ids where name = 'home-a'), tests.user_id('erin'), 'member', now() - interval '40 days'),
  ((select id from ids where name = 'home-a'), tests.user_id('finn'), 'member', now() - interval '5 days'),
  ((select id from ids where name = 'home-b'), tests.user_id('carol'), 'member', now() - interval '40 days'),
  ((select id from ids where name = 'home-b'), tests.user_id('gina'), 'administrator', now() - interval '40 days');
-- Nobody has signed in since before the requests below.
update auth.users set last_sign_in_at = now() - interval '60 days'
  where email in ('alice@madeora.test', 'bob@madeora.test');
insert into private.madeora_staff (user_id, note) values (tests.user_id('sam'), 'test reviewer');
-- Sam's sessions: one signed in an hour ago (say, a forgotten laptop) and one a minute ago.
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('50000000-0000-4000-8000-0000000000a1', tests.user_id('sam'), now() - interval '1 hour', now()),
  ('50000000-0000-4000-8000-0000000000a2', tests.user_id('sam'), now() - interval '1 minute', now());
insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id) values
  ('50000000-0000-4000-8000-0000000000a1', now() - interval '1 hour', now() - interval '1 hour',
   'password', gen_random_uuid()),
  ('50000000-0000-4000-8000-0000000000a2', now() - interval '1 minute', now() - interval '1 minute',
   'password', gen_random_uuid());

-- Act as Sam in the fresh session, or in the hour-old one.
create function tests.act_as_staff(p_fresh boolean) returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', tests.user_id('sam'), 'role', 'authenticated', 'aud', 'authenticated',
        'session_id', case when p_fresh then '50000000-0000-4000-8000-0000000000a2'
                           else '50000000-0000-4000-8000-0000000000a1' end)::text,
      true
    );
  end
  $$;
grant execute on function tests.act_as_staff(boolean) to authenticated, anon;

-- Out of the API's reach ----------------------------------------------------------------------------

select tests.act_as('dave');
select tests.assert_denied($$select * from private.madeora_staff$$, 'Nobody reads the staff list');
select tests.assert_denied(
  $$insert into private.madeora_staff (user_id) values (tests.user_id('dave'))$$,
  'Nobody makes themselves staff through the API'
);
select tests.assert_denied($$select * from private.home_ownership_recoveries$$,
  'Recovery cases are out of the API''s reach');
select tests.assert_denied($$select * from private.home_ownership_recovery_objections$$,
  'and so are objections');
select tests.assert_denied($$select * from private.home_ownership_recovery_appeals$$,
  'and appeals');
select tests.assert_true(not public.is_madeora_staff(), 'Dave is not staff');
select tests.act_as_staff(true);
select tests.assert_true(public.is_madeora_staff(), 'Sam is staff');
select tests.assert_denied(
  $$select * from public.home_directory((select id from ids where name = 'home-a'))$$,
  'Staff status gives no access to a Home'
);
select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.request_ownership_recovery(gen_random_uuid(), repeat('x', 60), gen_random_uuid())$$,
  'Visitors cannot ask'
);

-- Who may ask ---------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.request_ownership_recovery((select id from ids where name = 'home-a'),
    'I am the Owner and I would like to recover my own Home, please help me with it.',
    gen_random_uuid())) = 'not_permitted',
  'The Owner does not ask for a recovery of their own Home'
);
select tests.act_as('finn');
select tests.assert_true(
  (select outcome from public.request_ownership_recovery((select id from ids where name = 'home-a'),
    'Alice has not been reachable for months and the Home needs someone to manage it.',
    gen_random_uuid())) = 'not_permitted',
  'A member for less than 30 days cannot ask'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.request_ownership_recovery((select id from ids where name = 'home-a'),
    'I would like to take over this Home because nobody is managing it any more.',
    gen_random_uuid())) = 'not_found',
  'Someone from another Home gets not_found'
);
select tests.act_as('dave');
select tests.assert_denied(
  $$select * from public.request_ownership_recovery((select id from ids where name = 'home-a'),
    'too short', gen_random_uuid())$$,
  'A statement under 50 characters is refused',
  '22023'
);

-- Requests ------------------------------------------------------------------------------------------

insert into ids select 'dave-request', gen_random_uuid();
insert into ids select 'case-dave', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-a'),
  'Alice passed away in March; her account cannot be recovered. I am her son and can show ID.',
  (select id from ids where name = 'dave-request'));
select tests.assert_true(
  (select id from ids where name = 'case-dave') is not null,
  'An Administrator who joined 40 days ago asks'
);
select tests.assert_true(
  (select recovery_id from public.request_ownership_recovery((select id from ids where name = 'home-a'),
    'Alice passed away in March; her account cannot be recovered. I am her son and can show ID.',
    (select id from ids where name = 'dave-request'))) = (select id from ids where name = 'case-dave'),
  'Repeating the same request returns the same case'
);
select tests.assert_true(
  (select outcome from public.request_ownership_recovery((select id from ids where name = 'home-a'),
    'A second request from me while the first one is still open, which should be refused.',
    gen_random_uuid())) = 'already_open',
  'One open request per person per Home'
);
select tests.act_as('erin');
insert into ids select 'case-erin', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-a'),
  'I also live here and I would like to manage the Home now that Alice cannot any more.',
  gen_random_uuid());
select tests.assert_true(
  (select id from ids where name = 'case-erin') is not null,
  'A second member may ask too (competing requests)'
);

-- What people see -----------------------------------------------------------------------------------

select tests.act_as('dave');
select tests.assert_true(
  (select state from public.home_ownership_recovery_status((select id from ids where name = 'home-a'))
    where viewer = 'claimant') = 'submitted',
  'The person who asked sees their request as submitted'
);
select tests.act_as('finn');
select tests.assert_row_count(
  $$select * from public.home_ownership_recovery_status((select id from ids where name = 'home-a'))
    where viewer = 'member' and claimant_membership_id is null and objection_ends_at is null$$,
  2,
  'Other members see only that reviews are open, not who asked'
);
select tests.act_as('bob');
select tests.assert_denied(
  $$select * from public.home_ownership_recovery_status((select id from ids where name = 'home-a'))$$,
  'Someone from another Home sees nothing'
);
select tests.act_as('dave');
select tests.assert_denied($$select * from public.staff_ownership_recoveries()$$,
  'Members cannot open the staff queue');
select tests.assert_denied(
  $$select * from public.staff_ownership_recovery((select id from ids where name = 'case-dave'))$$,
  'nor read a case''s statement'
);
select tests.assert_denied(
  $$select public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'approve', 'I approve my own request, obviously.', 'member')$$,
  'nor decide one'
);

-- Staff review --------------------------------------------------------------------------------------

select tests.act_as_staff(true);
select tests.assert_row_count($$select * from public.staff_ownership_recoveries()$$, 2,
  'Staff see the queue');
select tests.assert_true(
  (select statement from public.staff_ownership_recovery((select id from ids where name = 'case-dave')))
    like 'Alice passed away%'
  and (select owner_email from public.staff_ownership_recovery((select id from ids where name = 'case-dave')))
    = 'alice@madeora.test'
  and (select claimant_role from public.staff_ownership_recovery((select id from ids where name = 'case-dave')))
    = 'administrator',
  'Staff read the statement, the Owner''s email and the person''s role'
);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'ownership_recovery.viewed_by_staff'
      and e.subject_id = (select id from ids where name = 'case-dave')
      and e.actor_user_id = tests.user_id('sam')) >= 1,
  'Each staff read is audited with the staff account'
);
-- The hour-old session cannot decide, although Sam signed in elsewhere a minute ago.
select tests.act_as_staff(false);
select tests.assert_denied(
  $$select public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'start_review', null, null)$$,
  'A staff decision needs a sign-in within 15 minutes in this session'
);
select tests.act_as_user(tests.user_id('sam'));
select tests.assert_denied(
  $$select public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'start_review', null, null)$$,
  'and a token without a session cannot decide either'
);
-- Staff who belong to the Home neither see nor decide its requests.
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values ((select id from ids where name = 'home-a'), tests.user_id('sam'), 'member');
select tests.act_as_staff(true);
select tests.assert_true(
  not exists (select 1 from public.staff_ownership_recoveries() q
    where q.id = (select id from ids where name = 'case-dave'))
  and not exists (select 1 from public.staff_ownership_recovery(
    (select id from ids where name = 'case-dave')))
  and public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'start_review', null, null) = 'not_found',
  'A staff member who belongs to the Home cannot see or decide its request'
);
select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('sam');
select tests.act_as_staff(true);
select tests.assert_true(
  public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'approve', 'Checked ID by video call.', 'member') = 'not_allowed',
  'A request is reviewed before it can be approved'
);
select tests.assert_true(
  public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'start_review', null, null) = 'ok',
  'Staff start the review'
);
select tests.assert_denied(
  $$select public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'approve', null, 'member')$$,
  'Approval needs a written reason',
  '22023'
);
select tests.assert_true(
  public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'approve', 'Checked ID and death certificate by video call.', 'member') = 'ok',
  'Staff approve, with a reason'
);
select tests.act_as('erin');
select tests.assert_true(
  (select state from public.home_ownership_recovery_status((select id from ids where name = 'home-a'))
    where viewer = 'claimant') = 'rejected',
  'Approving one request rejects the competing one'
);
select tests.act_as('dave');
select tests.assert_true(
  (select state from public.home_ownership_recovery_status((select id from ids where name = 'home-a'))
    where viewer = 'claimant') = 'approved',
  'The person who asked sees the approval and the objection period'
);
select tests.assert_true(
  public.accept_ownership_recovery((select id from ids where name = 'home-a'),
    (select id from ids where name = 'case-dave')) = 'not_ready',
  'Nobody takes over during the objection period'
);

-- Objection -----------------------------------------------------------------------------------------

select tests.act_as('finn');
select tests.assert_true(
  public.object_to_ownership_recovery((select id from ids where name = 'home-a'),
    'Alice is on a long trip, not gone; I spoke to her last week.') = 'objected',
  'Another member objects'
);
select tests.act_as('dave');
select tests.assert_true(
  (select state from public.home_ownership_recovery_status((select id from ids where name = 'home-a'))
    where viewer = 'claimant') = 'paused',
  'An objection pauses the case'
);
select tests.assert_true(
  public.object_to_ownership_recovery((select id from ids where name = 'home-a'),
    'I object to my own request for some reason.') = 'not_permitted',
  'The person who asked cannot object to their own request'
);
select tests.act_as_staff(true);
select tests.assert_true(
  (select objections->0->>'reason' from public.staff_ownership_recovery(
    (select id from ids where name = 'case-dave'))) like 'Alice is on a long trip%',
  'Staff read the objection'
);
select tests.assert_true(
  public.staff_decide_ownership_recovery((select id from ids where name = 'case-dave'),
    'resume', 'Called Finn; the trip story was a misunderstanding.', null) = 'ok',
  'Staff resume after looking into it'
);
select tests.act_as('dave');
select tests.assert_true(
  (select state from public.home_ownership_recovery_status((select id from ids where name = 'home-a'))
    where viewer = 'claimant') = 'approved'
  and (select objection_ends_at from public.home_ownership_recovery_status(
    (select id from ids where name = 'home-a')) where viewer = 'claimant') >= now() + interval '13 days',
  'Resuming starts a fresh 14-day objection period'
);

-- Completion ----------------------------------------------------------------------------------------

select tests.act_as_owner();
update private.home_ownership_recoveries set objection_ends_at = now() - interval '1 minute'
  where id = (select id from ids where name = 'case-dave');
select tests.act_as('erin');
select tests.assert_true(
  public.accept_ownership_recovery((select id from ids where name = 'home-a'),
    (select id from ids where name = 'case-dave')) = 'not_found',
  'Only the person who asked can accept'
);
select tests.act_as('dave');
select tests.assert_true(
  public.accept_ownership_recovery((select id from ids where name = 'home-a'),
    (select id from ids where name = 'case-dave')) = 'completed',
  'After the period, the person who asked accepts'
);
select tests.act_as_owner();
select tests.assert_true(
  (select role from public.home_memberships
    where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('dave')) = 'owner'
  and (select role from public.home_memberships
    where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice')) = 'member'
  and (select count(*) from public.home_memberships
    where home_id = (select id from ids where name = 'home-a') and role = 'owner') = 1,
  'Dave is the only Owner; Alice is a Member'
);
select tests.assert_true(
  not exists (
    select 1 from private.audit_events e
    where e.subject_type = 'ownership_recovery'
      and (e.details::text ilike '%@%' or e.details::text ilike '%passed away%'
           or e.details::text ilike '%trip%')
  ),
  'No audit row holds an email, a statement or an objection'
);
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'ownership_recovery.completed'
      and e.subject_id = (select id from ids where name = 'case-dave')) = 1,
  'The completion is audited'
);

-- Appeal --------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select still_member from public.my_recovered_homes()
    where recovery_id = (select id from ids where name = 'case-dave')),
  'The former Owner sees what happened'
);
select tests.assert_true(
  public.appeal_ownership_recovery((select id from ids where name = 'case-dave'),
    'I was only travelling and nobody contacted me properly.') = 'appealed',
  'The former Owner appeals'
);
select tests.assert_true(
  public.appeal_ownership_recovery((select id from ids where name = 'case-dave'),
    'And a second appeal while the first is open.') = 'already_open',
  'One open appeal at a time'
);
select tests.act_as('dave');
select tests.assert_true(
  public.appeal_ownership_recovery((select id from ids where name = 'case-dave'),
    'I would like to appeal too, even though I won.') = 'not_found',
  'Only the former Owner appeals'
);
select tests.act_as_staff(true);
select tests.assert_true(
  public.staff_close_recovery_appeal(
    ((select appeals->0->>'id' from public.staff_ownership_recovery(
      (select id from ids where name = 'case-dave'))))::uuid,
    'Spoke to both; Alice agreed the handover stands.') = 'closed',
  'Staff close the appeal; nothing reverses automatically'
);
select tests.act_as_owner();
select tests.assert_true(
  (select role from public.home_memberships
    where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('dave')) = 'owner',
  'The appeal changed nothing in the Home'
);

-- Withdrawal and departure -------------------------------------------------------------------------

select tests.act_as('erin');
insert into ids select 'case-erin-2', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-a'),
  'Dave is not reachable any more either; I would like the Home reviewed again, please.',
  gen_random_uuid());
select tests.assert_true(
  public.withdraw_ownership_recovery((select id from ids where name = 'home-a'),
    (select id from ids where name = 'case-erin-2')) = 'withdrawn',
  'The person who asked can withdraw'
);
insert into ids select 'case-erin-3', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-a'),
  'Asking again after withdrawing, to check that leaving the Home ends the request.',
  gen_random_uuid());
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'left',
  'Erin leaves the Home'
);
select tests.act_as_owner();
select tests.assert_true(
  (select status from private.home_ownership_recoveries
    where id = (select id from ids where name = 'case-erin-3')) = 'invalid',
  'Leaving ends the person''s open request'
);

-- The Owner shows they have access -----------------------------------------------------------------

select tests.act_as('carol');
insert into ids select 'case-carol', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Bob has not answered anyone for months and his phone number no longer works at all.',
  gen_random_uuid());
select tests.act_as('bob');
select tests.assert_true(
  (select viewer from public.home_ownership_recovery_status((select id from ids where name = 'home-b'))
    where id = (select id from ids where name = 'case-carol')) = 'owner'
  and (select claimant_membership_id from public.home_ownership_recovery_status(
    (select id from ids where name = 'home-b')) where id = (select id from ids where name = 'case-carol'))
    is not null,
  'The Owner sees the request and who made it'
);
select tests.act_as_staff(true);
select tests.assert_true(
  public.staff_decide_ownership_recovery((select id from ids where name = 'case-carol'),
    'start_review', null, null) = 'owner_returned',
  'Opening the Home as Owner stops the request'
);
select tests.act_as('carol');
select tests.assert_true(
  (select state from public.home_ownership_recovery_status((select id from ids where name = 'home-b'))
    where viewer = 'claimant') = 'owner_returned',
  'The person who asked sees that the Owner is back'
);

insert into ids select 'case-carol-2', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Asking again: I still cannot reach Bob and nobody can manage the Home without him.',
  gen_random_uuid());
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.cancel_ownership_recoveries((select id from ids where name = 'home-b'))) = 'cancelled',
  'The Owner cancels open requests'
);
select tests.act_as('gina');
select tests.assert_true(
  (select outcome from public.cancel_ownership_recoveries((select id from ids where name = 'home-b'))) = 'not_permitted',
  'Only the Owner cancels'
);

insert into ids select 'case-gina', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Bob moved abroad and lost access to his email; his account cannot be recovered.',
  gen_random_uuid());
select tests.act_as_owner();
update auth.users set last_sign_in_at = clock_timestamp() where email = 'bob@madeora.test';
select tests.act_as_staff(true);
select tests.assert_true(
  public.staff_decide_ownership_recovery((select id from ids where name = 'case-gina'),
    'start_review', null, null) = 'owner_returned',
  'The Owner signing in after the request stops it too'
);

-- Removal of the former Owner, decided by staff -----------------------------------------------------

select tests.act_as('gina');
insert into ids select 'case-gina-2', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Bob sold his share of the house and moved out; he agreed I take over but cannot sign in.',
  gen_random_uuid());
select tests.act_as_staff(true);
select tests.assert_true(
  public.staff_decide_ownership_recovery((select id from ids where name = 'case-gina-2'),
    'start_review', null, null) = 'ok'
  and public.staff_decide_ownership_recovery((select id from ids where name = 'case-gina-2'),
    'approve', 'Verified the sale and Bob''s written consent.', 'removed') = 'ok',
  'Staff approve with the former Owner leaving the Home'
);
select tests.act_as_owner();
update private.home_ownership_recoveries set objection_ends_at = now() - interval '1 minute'
  where id = (select id from ids where name = 'case-gina-2');
select tests.act_as('gina');
select tests.assert_true(
  public.accept_ownership_recovery((select id from ids where name = 'home-b'),
    (select id from ids where name = 'case-gina-2')) = 'completed',
  'Gina accepts'
);
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from public.home_memberships
    where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('bob'))
  and (select count(*) from public.home_memberships
    where home_id = (select id from ids where name = 'home-b') and role = 'owner') = 1,
  'Bob is out of Home B, which still has exactly one Owner'
);
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'home_membership.removed' and e.subject_id = tests.user_id('bob')
      and e.home_id = (select id from ids where name = 'home-b')) = 1,
  'The former Owner''s departure is audited as a removal'
);
select tests.act_as('bob');
select tests.assert_true(
  (select home_name from public.my_recovered_homes()
    where recovery_id = (select id from ids where name = 'case-gina-2')) = 'Elders'
  and not (select still_member from public.my_recovered_homes()
    where recovery_id = (select id from ids where name = 'case-gina-2')),
  'The removed former Owner still sees what happened, to appeal'
);
select tests.assert_denied(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))$$,
  'but has no access to the Home any more'
);
