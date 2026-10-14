-- S10: invitations, join requests and approval (supabase/migrations/*_home_invitations.sql).
-- Alice owns Home A, Bob owns Home B, Carol is a Member of Home A and an Administrator of Home B.
-- Dave, Erin and Finn are new confirmed accounts with no Home; Uma's email is not confirmed.
-- Everything goes through the public functions; the tables are out of the API's reach.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
create temporary table secrets (name text primary key, token text not null) on commit drop;
grant all on ids, secrets to authenticated;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'erin@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'finn@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'uma@madeora.test', null, now(), now());
insert into public.user_preferences (user_id, display_name)
  values ('30000000-0000-4000-8000-000000000001', 'Dave D');

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Elders', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member'),
  ((select id from ids where name = 'home-b'), tests.user_id('carol'), 'administrator');

-- Out of the API's reach ----------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  'select token from private.home_invitations', 'Invitations (and their secrets) are not readable through the API'
);
select tests.assert_denied(
  'select applicant_email from private.home_join_requests', 'Join requests are not readable through the API'
);
select tests.assert_denied(
  $$select private.can_manage_invitations(gen_random_uuid(), auth.uid(), 'member')$$,
  'The private helpers cannot be called through the API'
);
select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 1)$$,
  'A signed-out visitor cannot create invitations'
);
select tests.assert_denied(
  $$select * from public.preview_home_invitation('AAAAA-AAAAA')$$,
  'A signed-out visitor cannot look up invitations'
);
select tests.act_as_user('30000000-0000-4000-8000-000000000004');
select tests.assert_denied(
  $$select * from public.preview_home_invitation('AAAAA-AAAAA')$$,
  'An account without a confirmed email cannot look up invitations'
);

-- Who may create ------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 1)) = 'not_permitted',
  'A Member cannot create invitations'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-b'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 1)) = 'not_permitted',
  'An Administrator without a granted capability cannot create invitations (least privilege until S12)'
);
select tests.assert_denied(
  $$select * from public.list_home_invitations((select id from ids where name = 'home-a'))$$,
  'A Member cannot list invitations (or see recipient emails)'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 1)) = 'not_found',
  'An outsider cannot create invitations for another Home, and learns nothing about it'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation(gen_random_uuid(),
    'link', 'member', gen_random_uuid(), null, null, '7d', 1)) = 'not_found',
  'A Home that does not exist answers like a foreign one'
);

-- Input rules ---------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'owner', gen_random_uuid(), null, null, '7d', 1)$$,
  'An invitation can never propose the Owner role', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'join_code', 'administrator', gen_random_uuid(), null, null, '7d', null)$$,
  'A join code cannot propose the Administrator role', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 11)$$,
  'A multi-use cap above 10 is refused', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 0)$$,
  'A cap of 0 is refused', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '14d', 1)$$,
  'Only 24 hours, 7 days or 30 days are offered', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'email', 'member', gen_random_uuid(), 'dave@madeora.test', 'en', '30d', 1)$$,
  'Email invitations always last 7 days', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'email', 'member', gen_random_uuid(), 'not an address', 'en', '7d', 1)$$,
  'A malformed recipient address is refused', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), 'dave@madeora.test', null, '7d', 1)$$,
  'Only email invitations name a recipient', '22023'
);

-- Creating ------------------------------------------------------------------------------------------

insert into ids values ('email-request', '40000000-0000-4000-8000-000000000001');
insert into secrets
  select 'email-dave', token from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'email', 'member', (select id from ids where name = 'email-request'), '  Dave@Madeora.TEST ', 'nl',
    null, 1);
select tests.assert_true(
  (select token from secrets where name = 'email-dave') ~ '^[A-Za-z0-9_-]{43}$',
  'An email invitation gets a 256-bit link secret'
);
select tests.assert_true(
  (select outcome = 'existing' and token = (select token from secrets where name = 'email-dave')
   from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'email', 'member', (select id from ids where name = 'email-request'), 'dave@madeora.test', 'nl',
    null, 1)),
  'Repeating a creation request returns the same invitation'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'email', 'member', gen_random_uuid(), 'DAVE@madeora.test', 'en',
    null, 1)) = 'duplicate_email',
  'A second active invitation to the same address in the same Home is refused'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.create_home_invitation(
    (select id from ids where name = 'home-b'), 'email', 'member', gen_random_uuid(), 'dave@madeora.test', 'en',
    null, 1)) = 'created',
  'Another Home may invite the same address'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation(
    (select id from ids where name = 'home-b'), 'email', 'member', gen_random_uuid(), 'nobody-has-this@madeora.test',
    'en', null, 1)) = 'created',
  'Inviting an address without an account answers exactly like one with an account'
);

select tests.act_as('alice');
insert into secrets
  select 'link-single', token from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'link', 'member', gen_random_uuid(), null, null, '24h', 1);
insert into secrets
  select 'link-multi', token from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'link', 'member', gen_random_uuid(), null, null, '30d', 2);
insert into secrets
  select 'link-admin', token from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'link', 'administrator', gen_random_uuid(), null, null, '7d', 1);
insert into secrets
  select 'code', token from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'join_code', 'member', gen_random_uuid(), null, null, null, null);
select tests.assert_true(
  (select token from secrets where name = 'code') ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$',
  'A join code is 10 Crockford base32 characters'
);

select tests.assert_row_count(
  $$select id from public.list_home_invitations((select id from ids where name = 'home-a'))
    where state = 'active'$$,
  5, 'The Owner lists the Home''s five active invitations'
);
select tests.assert_row_count(
  $$select id from public.list_home_invitations((select id from ids where name = 'home-a'))
    where token is not null$$,
  4, 'Links and codes come with their secret for copying; email invitations never do'
);
select tests.assert_row_count(
  $$select id from public.list_home_invitations((select id from ids where name = 'home-a'))
    where kind = 'email' and recipient_email = 'dave@madeora.test' and email_locale = 'nl'$$,
  1, 'The recipient is stored in lower case, trimmed'
);
select tests.assert_true(
  (select expires_at - created_at from public.list_home_invitations((select id from ids where name = 'home-a'))
   where kind = 'link' and max_admissions = 2) = interval '30 days',
  'The chosen expiry starts when the invitation is issued'
);
select tests.act_as('bob');
select tests.assert_denied(
  $$select * from public.list_home_invitations((select id from ids where name = 'home-a'))$$,
  'Another Home''s Owner cannot list these invitations'
);

-- Previewing ----------------------------------------------------------------------------------------

select tests.act_as_user('30000000-0000-4000-8000-000000000002'); -- Erin
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'email-dave')))
    = 'email_mismatch',
  'A forwarded email invitation is refused for another verified email'
);
select tests.assert_true(
  (select home_name is null and role is null from public.preview_home_invitation(
    (select token from secrets where name = 'email-dave'))),
  'The mismatch reveals neither the Home nor the role'
);
select tests.assert_true(
  (select outcome = 'ok' and home_name = 'Thuis' and role = 'member' and kind = 'link'
   from public.preview_home_invitation((select token from secrets where name = 'link-multi'))),
  'A link shows only the Home name, the proposed role and the kind'
);
select tests.assert_true(
  (select outcome from public.preview_home_invitation(
    lower(substr((select token from secrets where name = 'code'), 1, 5)) || ' - '
      || substr((select token from secrets where name = 'code'), 6))) = 'ok',
  'A join code can be typed in lower case with spaces and a dash'
);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'already_member' and home_id = (select id from ids where name = 'home-a')
   from public.preview_home_invitation((select token from secrets where name = 'link-multi'))),
  'A current member sees that they already belong to the Home'
);
select tests.assert_true(
  (select outcome from public.request_to_join_home((select token from secrets where name = 'link-multi')))
    = 'already_member',
  'A current member cannot request a second membership'
);

-- Requesting ----------------------------------------------------------------------------------------

select tests.act_as_user('30000000-0000-4000-8000-000000000001'); -- Dave
select tests.assert_true(
  (select outcome = 'ok' and role = 'member' and kind = 'email'
   from public.preview_home_invitation((select token from secrets where name = 'email-dave'))),
  'The invited address, verified on the account, may use the email invitation'
);
insert into ids
  select 'request-dave', request_id from public.request_to_join_home(
    (select token from secrets where name = 'email-dave'));
select tests.assert_true(
  (select outcome = 'pending' and request_id = (select id from ids where name = 'request-dave')
   from public.request_to_join_home((select token from secrets where name = 'email-dave'))),
  'Asking again returns the pending request instead of a second one'
);
select tests.assert_true(
  (select outcome from public.request_to_join_home((select token from secrets where name = 'link-multi')))
    = 'pending',
  'One pending request per person per Home, whichever invitation is used'
);
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-a')$$,
  0, 'A pending request gives no access to the Home'
);
select tests.assert_row_count(
  $$select id from public.list_my_join_requests() where state = 'pending' and home_name = 'Thuis'
    and role = 'member' and kind = 'invitation' and home_id is null$$,
  1, 'Dave sees his own pending request'
);

select tests.act_as_user('30000000-0000-4000-8000-000000000002'); -- Erin
insert into ids
  select 'request-erin', request_id from public.request_to_join_home(
    (select token from secrets where name = 'link-multi'));
select tests.act_as_user('30000000-0000-4000-8000-000000000003'); -- Finn
insert into ids
  select 'request-finn', request_id from public.request_to_join_home(
    (select token from secrets where name = 'link-multi'));
select tests.assert_true(
  public.withdraw_join_request((select id from ids where name = 'request-erin')) = 'not_found',
  'Only the applicant can withdraw their request'
);

select tests.act_as('alice');
select tests.assert_row_count(
  $$select id from public.list_home_join_requests((select id from ids where name = 'home-a'))
    where state = 'pending'$$,
  3, 'The Owner sees the three pending requests'
);
select tests.assert_row_count(
  $$select id from public.list_home_join_requests((select id from ids where name = 'home-a'))
    where applicant_email = 'dave@madeora.test' and applicant_name = 'Dave D' and kind = 'email'$$,
  1, 'Managers see the applicant''s verified email and display name'
);
select tests.assert_true(
  public.count_pending_join_requests((select id from ids where name = 'home-a')) = 3,
  'The Owner''s dashboard count shows three'
);
select tests.act_as('carol');
select tests.assert_denied(
  $$select * from public.list_home_join_requests((select id from ids where name = 'home-a'))$$,
  'A Member cannot see join requests'
);
select tests.assert_true(
  public.count_pending_join_requests((select id from ids where name = 'home-a')) = 0,
  'A Member''s dashboard count is 0'
);
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-erin'), 'approve') = 'not_permitted',
  'A Member cannot approve'
);
select tests.act_as('bob');
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-erin'), 'approve') = 'not_found',
  'Another Home''s Owner cannot approve'
);
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-b'),
    (select id from ids where name = 'request-erin'), 'approve') = 'not_found',
  'A forged Home id does not reach another Home''s request'
);
select tests.act_as_user('30000000-0000-4000-8000-000000000002'); -- Erin
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-erin'), 'approve') = 'not_found',
  'An applicant cannot approve their own request'
);

-- Approving -----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-erin'), 'approve') = 'approved',
  'The Owner approves Erin'
);
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-erin'), 'approve') = 'already_decided',
  'A second approval of the same request changes nothing'
);
select tests.assert_true(
  (select admissions = 1 and state = 'active' from public.list_home_invitations((select id from ids where name = 'home-a'))
   where kind = 'link' and max_admissions = 2),
  'One approval used one of the link''s two admissions'
);
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-finn'), 'approve') = 'approved',
  'The Owner approves Finn with the last admission'
);
select tests.assert_true(
  (select state from public.list_home_invitations((select id from ids where name = 'home-a'))
   where kind = 'link' and max_admissions = 2) = 'used_up',
  'The multi-use link is used up after two approvals'
);
select tests.act_as_owner();
select tests.assert_row_count(
  $$select 1 from public.home_memberships where home_id = (select id from ids where name = 'home-a')
    and user_id in ('30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003')
    and role = 'member'$$,
  2, 'Approval created exactly the Member memberships'
);
select tests.act_as_user('30000000-0000-4000-8000-000000000002'); -- Erin
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-a')$$,
  1, 'After approval Erin sees the Home'
);
select tests.assert_row_count(
  $$select id from public.list_my_join_requests() where state = 'approved' and home_id is not null$$,
  1, 'Erin''s request shows Approved with a way to the Home'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'link-multi')))
    = 'used_up',
  'A used-up link is refused'
);

-- Declining and withdrawing -------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-dave'), 'decline') = 'declined',
  'The Owner declines Dave'
);
select tests.assert_true(
  (select state from public.list_home_invitations((select id from ids where name = 'home-a'))
   where kind = 'email') = 'declined',
  'Declining the recipient ends the email invitation'
);
select tests.act_as_user('30000000-0000-4000-8000-000000000001'); -- Dave
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-a')$$,
  0, 'A declined applicant has no access'
);
select tests.assert_true(
  (select outcome from public.request_to_join_home((select token from secrets where name = 'email-dave')))
    = 'declined',
  'A declined applicant cannot ask again with the same invitation'
);
select tests.assert_row_count(
  $$select id from public.list_my_join_requests() where state = 'declined'$$,
  1, 'Dave sees Declined'
);
insert into ids
  select 'request-dave-code', request_id from public.request_to_join_home(
    (select token from secrets where name = 'code'));
select tests.assert_true(
  public.withdraw_join_request((select id from ids where name = 'request-dave-code')) = 'withdrawn',
  'An applicant withdraws a pending request'
);
select tests.assert_true(
  public.withdraw_join_request((select id from ids where name = 'request-dave-code')) = 'not_pending',
  'A withdrawn request cannot be withdrawn again'
);
select tests.act_as('alice');
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-dave-code'), 'approve') = 'already_decided',
  'A withdrawn request cannot be approved'
);

-- Approval re-checks everything ---------------------------------------------------------------------

-- Expiry between request and approval.
select tests.act_as_user('30000000-0000-4000-8000-000000000001'); -- Dave
insert into ids
  select 'request-dave-single', request_id from public.request_to_join_home(
    (select token from secrets where name = 'link-single'));
select tests.act_as_owner();
update private.home_invitations set expires_at = now() - interval '1 second'
  where token = (select token from secrets where name = 'link-single');
select tests.act_as_user('30000000-0000-4000-8000-000000000001');
select tests.assert_row_count(
  $$select id from public.list_my_join_requests() where state = 'expired'$$,
  1, 'A pending request whose link expired shows Expired'
);
select tests.act_as('alice');
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-dave-single'), 'approve') = 'no_longer_valid',
  'An expired link cannot admit anyone, even with a request made in time'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'link-single')))
    = 'expired',
  'An expired link shows Expired'
);

-- Revocation between request and approval; a revoked join code.
select tests.act_as('bob');
insert into ids
  select 'request-bob-code', request_id from public.request_to_join_home(
    (select token from secrets where name = 'code'));
select tests.act_as('alice');
select tests.assert_true(
  public.revoke_home_invitation((select id from ids where name = 'home-a'),
    (select id from public.list_home_invitations((select id from ids where name = 'home-a'))
     where kind = 'join_code')) = 'revoked',
  'The Owner revokes the join code'
);
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-bob-code'), 'approve') = 'no_longer_valid',
  'A revoked code cannot admit a pending applicant'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'code')))
    = 'revoked',
  'A revoked code shows Revoked'
);
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-a')$$,
  0, 'Bob never got into Home A'
);

-- Administrator invitations: Owner-only, role kept.
select tests.act_as('bob');
insert into ids
  select 'request-bob-admin', request_id from public.request_to_join_home(
    (select token from secrets where name = 'link-admin'));
select tests.act_as('alice');
select tests.assert_row_count(
  $$select id from public.list_home_join_requests((select id from ids where name = 'home-a'))
    where id = (select id from ids where name = 'request-bob-admin') and role = 'administrator'
      and can_decide$$,
  1, 'The request carries the invitation''s Administrator role'
);
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'),
    (select id from ids where name = 'request-bob-admin'), 'approve') = 'approved',
  'The Owner approves an Administrator invitation'
);
select tests.act_as_owner();
select tests.assert_row_count(
  $$select 1 from public.home_memberships where home_id = (select id from ids where name = 'home-a')
    and user_id = tests.user_id('bob') and role = 'administrator'$$,
  1, 'Bob joined as Administrator, exactly the invited role'
);
-- Bob is now an Administrator of Home A without the (S12) capability: still cannot manage.
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 1)) = 'not_permitted',
  'A newly admitted Administrator gets no invitation powers by default'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'administrator', gen_random_uuid(), null, null, '7d', 1)) = 'not_permitted',
  'An Administrator cannot invite Administrators'
);

-- The inviter loses the authority.
select tests.act_as('alice');
insert into secrets
  select 'link-alice', token from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'link', 'member', gen_random_uuid(), null, null, '7d', 1);
select tests.act_as_owner();
-- Stand-in for an ownership transfer (S12): Alice becomes a Member, Carol the Owner.
update public.home_memberships set role = 'member'
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');
update public.home_memberships set role = 'owner'
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
select tests.act_as_user('30000000-0000-4000-8000-000000000001'); -- Dave
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'link-alice')))
    = 'invalid',
  'An invitation whose inviter lost the authority can no longer be used'
);
select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.list_home_invitations((select id from ids where name = 'home-a'))$$,
  'A demoted Owner loses access to the invitation list at once'
);
select tests.act_as_owner();
update public.home_memberships set role = 'member'
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
update public.home_memberships set role = 'owner'
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');

-- The applicant's email changes, or the request belongs to someone who already joined.
select tests.act_as('alice');
insert into secrets
  select 'email-erin-b', token from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'email', 'member', gen_random_uuid(), 'erin@madeora.test', 'en',
    null, 1);
-- Erin is already a member of Home A: the email invitation tells her so.
select tests.act_as_user('30000000-0000-4000-8000-000000000002');
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'email-erin-b')))
    = 'already_member',
  'The recipient who already belongs sees that, without a duplicate membership'
);
select tests.act_as('bob');
insert into secrets
  select 'email-finn-b', token from public.create_home_invitation(
    (select id from ids where name = 'home-b'), 'email', 'member', gen_random_uuid(), 'finn@madeora.test', 'en',
    null, 1);
select tests.act_as_user('30000000-0000-4000-8000-000000000003'); -- Finn
insert into ids
  select 'request-finn-b', request_id from public.request_to_join_home(
    (select token from secrets where name = 'email-finn-b'));
select tests.act_as_owner();
update auth.users set email = 'finn-new@madeora.test'
  where id = '30000000-0000-4000-8000-000000000003';
select tests.act_as('bob');
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-b'),
    (select id from ids where name = 'request-finn-b'), 'approve') = 'no_longer_valid',
  'Approval re-checks that the applicant still has the invited verified email'
);

-- Resend and renew ----------------------------------------------------------------------------------

select tests.act_as('alice');
insert into ids
  select 'email-gus', invitation_id from public.create_home_invitation(
    (select id from ids where name = 'home-a'), 'email', 'administrator', gen_random_uuid(), 'gus@madeora.test', 'en',
    null, 1);
select tests.assert_true(
  (select outcome from public.resend_home_invitation((select id from ids where name = 'home-a'),
    (select id from ids where name = 'email-gus'))) = 'rate_limited',
  'Resending right after sending is refused (one send per minute)'
);
select tests.act_as_owner();
update private.home_invitations set last_sent_at = now() - interval '2 minutes'
  where id = (select id from ids where name = 'email-gus');
insert into secrets
  select 'gus-before', token from private.home_invitations where id = (select id from ids where name = 'email-gus');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'ok' and token = (select token from secrets where name = 'gus-before')
     and recipient_email = 'gus@madeora.test' and role = 'administrator' and home_name = 'Thuis'
   from public.resend_home_invitation((select id from ids where name = 'home-a'),
     (select id from ids where name = 'email-gus'))),
  'Resend returns the same link, recipient and role'
);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.resend_home_invitation((select id from ids where name = 'home-a'),
    (select id from ids where name = 'email-gus'))) = 'not_permitted',
  'A Member cannot resend'
);
select tests.act_as_owner();
update private.home_invitations
  set last_sent_at = now() - interval '2 minutes', expires_at = now() + interval '1 day'
  where id = (select id from ids where name = 'email-gus');
select tests.act_as('alice');
insert into secrets
  select 'gus-after', token from public.renew_home_invitation(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'email-gus'));
select tests.assert_true(
  (select token from secrets where name = 'gus-after') <> (select token from secrets where name = 'gus-before'),
  'Renew issues a new link'
);
select tests.assert_true(
  (select expires_at from public.list_home_invitations((select id from ids where name = 'home-a'))
   where id = (select id from ids where name = 'email-gus')) = now() + interval '7 days',
  'Renew starts a fresh 7 days'
);
select tests.assert_row_count(
  $$select id from public.list_home_invitations((select id from ids where name = 'home-a'))
    where recipient_email = 'gus@madeora.test'$$,
  1, 'Renew does not create a second invitation'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'gus-before')))
    = 'invalid',
  'The old link is dead at once after renewal'
);
select tests.act_as_owner();
update private.home_invitations
  set last_sent_at = now() - interval '2 minutes', send_window_started_at = now() - interval '1 hour',
      sends_in_window = 5
  where id = (select id from ids where name = 'email-gus');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.renew_home_invitation((select id from ids where name = 'home-a'),
    (select id from ids where name = 'email-gus'))) = 'rate_limited',
  'At most 5 sends per invitation per 24 hours, renewals included'
);
select tests.assert_true(
  (select outcome from public.resend_home_invitation((select id from ids where name = 'home-a'),
    (select id from public.list_home_invitations((select id from ids where name = 'home-a'))
     where kind = 'link' and state = 'active' limit 1))) = 'not_email',
  'Only email invitations can be resent'
);
select tests.assert_true(
  public.record_home_invitation_delivery((select id from ids where name = 'home-a'),
    (select id from ids where name = 'email-gus'), 'failed') = 'ok',
  'A failed delivery is recorded'
);
select tests.assert_true(
  (select delivery_status from public.list_home_invitations((select id from ids where name = 'home-a'))
   where id = (select id from ids where name = 'email-gus')) = 'failed',
  'The failed delivery shows on the invitation'
);

-- The 25-invitation limit ---------------------------------------------------------------------------

select tests.act_as('alice');
select count(*) from (
  select public.create_home_invitation((select id from ids where name = 'home-a'), 'link', 'member', gen_random_uuid(),
    null, null, '7d', 1)
  from generate_series(1, 30)
) made;
select tests.assert_row_count(
  $$select id from public.list_home_invitations((select id from ids where name = 'home-a'))
    where state = 'active'$$,
  25, 'A Home never has more than 25 active invitations'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'join_code', 'member', gen_random_uuid(), null, null, '7d', null)) = 'limit_reached',
  'The 26th is refused with limit_reached'
);
select tests.assert_true(
  public.revoke_home_invitation((select id from ids where name = 'home-a'),
    (select id from public.list_home_invitations((select id from ids where name = 'home-a'))
     where kind = 'link' and state = 'active' limit 1)) = 'revoked',
  'Revoking one frees a place'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'join_code', 'member', gen_random_uuid(), null, null, '7d', null)) = 'created',
  'Expired, revoked, declined and used-up invitations do not count'
);
select tests.act_as_owner();
update private.home_invitations set last_sent_at = now() - interval '2 minutes', sends_in_window = 0
  where id = (select id from ids where name = 'email-gus');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.renew_home_invitation((select id from ids where name = 'home-a'),
    (select id from ids where name = 'email-gus'))) = 'ok',
  'Renewing at the limit works, because it never adds an invitation'
);

-- Guessing and spam ---------------------------------------------------------------------------------

select tests.act_as_user('30000000-0000-4000-8000-000000000001'); -- Dave
select count(*) from (
  select public.preview_home_invitation('ZZZZZ-ZZZZ' || n % 10) from generate_series(1, 9) n
) guesses;
select tests.assert_true(
  (select outcome from public.preview_home_invitation('not a code')) = 'invalid',
  'The tenth wrong code is still answered as invalid'
);
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'link-alice')))
    = 'rate_limited',
  'After 10 wrong codes in 15 minutes even a valid one is refused'
);
select tests.act_as_user('30000000-0000-4000-8000-000000000002'); -- Erin
select tests.assert_true(
  (select outcome from public.preview_home_invitation('ZZZZZ-ZZZZZ')) = 'invalid',
  'The limit is per account'
);

-- Home deleted while a request is pending -----------------------------------------------------------

select tests.act_as('bob');
insert into secrets
  select 'link-b', token from public.create_home_invitation(
    (select id from ids where name = 'home-b'), 'link', 'member', gen_random_uuid(), null, null, '7d', 1);
select tests.act_as_user('30000000-0000-4000-8000-000000000002'); -- Erin
insert into ids
  select 'request-erin-b', request_id from public.request_to_join_home(
    (select token from secrets where name = 'link-b'));
select tests.act_as_owner();
delete from public.homes where id = (select id from ids where name = 'home-b');
select tests.act_as_user('30000000-0000-4000-8000-000000000002');
select tests.assert_row_count(
  $$select id from public.list_my_join_requests() where id = (select id from ids where name = 'request-erin-b')$$,
  0, 'A deleted Home takes its pending requests with it'
);
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'link-b')))
    = 'invalid',
  'A deleted Home''s link is invalid'
);

-- Review fixes: stale requests, reused request ids, email limits -----------------------------------
-- Gina owns Home G; Hank asks to join it.

select tests.act_as_owner();
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-4000-8000-000000000005',
   'authenticated', 'authenticated', 'gina@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-4000-8000-000000000006',
   'authenticated', 'authenticated', 'hank@madeora.test', now(), now(), now());

select tests.act_as_user('30000000-0000-4000-8000-000000000005'); -- Gina
insert into ids select 'home-g', public.create_home('Huis G', 'Europe/Brussels', gen_random_uuid());
insert into secrets select 'link-g1', token from public.create_home_invitation(
  (select id from ids where name = 'home-g'), 'link', 'member', gen_random_uuid(),
  p_expires_in => '7d', p_max_admissions => 1);

select tests.act_as_user('30000000-0000-4000-8000-000000000006'); -- Hank
insert into ids select 'hank-request-1', request_id
  from public.request_to_join_home((select token from secrets where name = 'link-g1'));

-- The link expires before anyone decides.
select tests.act_as_owner();
update private.home_invitations set expires_at = now() - interval '1 minute'
  where token = (select token from secrets where name = 'link-g1');

select tests.act_as_user('30000000-0000-4000-8000-000000000005'); -- Gina
insert into secrets select 'link-g2', token from public.create_home_invitation(
  (select id from ids where name = 'home-g'), 'link', 'member', gen_random_uuid(),
  p_expires_in => '7d', p_max_admissions => 1);

select tests.act_as_user('30000000-0000-4000-8000-000000000006'); -- Hank
select tests.assert_true(
  (select outcome from public.preview_home_invitation((select token from secrets where name = 'link-g2')))
    = 'ok',
  'A request whose invitation expired no longer blocks a new invitation for the same Home'
);
select tests.assert_true(
  (select outcome from public.request_to_join_home((select token from secrets where name = 'link-g2')))
    = 'requested',
  'The applicant can ask again with the new invitation'
);
select tests.assert_true(
  (select state from public.list_my_join_requests()
     where id = (select id from ids where name = 'hank-request-1')) = 'expired',
  'The earlier request is closed as expired'
);

select tests.act_as_owner();
select tests.assert_true(
  (select status from private.home_join_requests
     where id = (select id from ids where name = 'hank-request-1')) = 'expired'
  and exists (select 1 from private.audit_events where action = 'join_request.expired'
     and subject_id = (select id from ids where name = 'hank-request-1')),
  'Closing a stale request is stored and audited'
);

-- A request id reused with other content is refused; the same content returns the same invitation.
select tests.act_as_user('30000000-0000-4000-8000-000000000005'); -- Gina
insert into ids values ('gina-request', gen_random_uuid());
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-g'),
     'email', 'member', (select id from ids where name = 'gina-request'),
     p_recipient_email => 'one@madeora.test', p_email_locale => 'en', p_max_admissions => 1))
    = 'created',
  'Gina invites one@'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-g'),
     'email', 'member', (select id from ids where name = 'gina-request'),
     p_recipient_email => ' ONE@madeora.test', p_email_locale => 'en', p_max_admissions => 1))
    = 'existing',
  'The same request again returns the same invitation'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-g'),
     'email', 'member', (select id from ids where name = 'gina-request'),
     p_recipient_email => 'two@madeora.test', p_email_locale => 'en', p_max_admissions => 1)$$,
  'A request id reused for another address is refused', '22023'
);
select tests.assert_denied(
  $$select * from public.create_home_invitation((select id from ids where name = 'home-g'),
     'link', 'member', (select id from ids where name = 'gina-request'),
     p_expires_in => '7d', p_max_admissions => 1)$$,
  'A request id reused for another kind is refused', '22023'
);

-- Invitation emails per account per day hold even when invitations are revoked and made again.
-- One email so far (one@); 19 more create-and-revoke rounds reach the limit of 20.
do $$
declare
  v_inv uuid;
begin
  for i in 1..19 loop
    select invitation_id into v_inv from public.create_home_invitation(
      (select id from ids where name = 'home-g'), 'email', 'member', gen_random_uuid(),
      p_recipient_email => 'loop' || i || '@madeora.test', p_email_locale => 'en',
      p_max_admissions => 1);
    perform public.revoke_home_invitation((select id from ids where name = 'home-g'), v_inv);
  end loop;
end
$$;
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-g'),
     'email', 'member', gen_random_uuid(),
     p_recipient_email => 'loop20@madeora.test', p_email_locale => 'en', p_max_admissions => 1))
    = 'rate_limited',
  'The 21st invitation email of the day is refused, though only one invitation is active'
);
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-g'),
     'link', 'member', gen_random_uuid(), p_expires_in => '7d', p_max_admissions => 1)) = 'created',
  'Links and codes send no email and are not limited by it'
);
select tests.act_as_owner();
update private.home_invitations set last_sent_at = now() - interval '2 minutes'
  where recipient_email = 'one@madeora.test';
select tests.act_as_user('30000000-0000-4000-8000-000000000005'); -- Gina
select tests.assert_true(
  (select outcome from public.resend_home_invitation((select id from ids where name = 'home-g'),
     (select invitation_id from public.create_home_invitation((select id from ids where name = 'home-g'),
        'email', 'member', (select id from ids where name = 'gina-request'),
        p_recipient_email => 'one@madeora.test', p_email_locale => 'en', p_max_admissions => 1))))
    = 'rate_limited',
  'Resends count toward the same daily limit'
);

-- Audit ---------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from private.audit_events where action = 'join_request.approved'
     and home_id = (select id from ids where name = 'home-a')) = 3,
  'Every approval is audited'
);
select tests.assert_true(
  (select count(*) from private.audit_events where action = 'home_membership.created'
     and home_id = (select id from ids where name = 'home-a') and actor_user_id = tests.user_id('alice')
     and subject_id = '30000000-0000-4000-8000-000000000002') = 1,
  'The new membership is audited with the approver as actor'
);
select tests.assert_true(
  (select count(distinct action) from private.audit_events where action in (
    'invitation.created', 'invitation.revoked', 'invitation.resent', 'invitation.renewed',
    'join_request.created', 'join_request.withdrawn', 'join_request.declined',
    'join_request.expired')) = 8,
  'Creating, revoking, resending, renewing, requesting, withdrawing, declining and expiring are audited'
);
select tests.assert_true(
  not exists (select 1 from private.audit_events where details::text ~ '@|Dave D|Thuis'),
  'Audit details hold no email addresses, names or Home names'
);
