-- S12: roles, Administrator capabilities, removal, leaving and ownership transfer
-- (supabase/migrations/*_roles_and_ownership.sql).
-- Home A: Alice is the Owner, Carol and Gina are Administrators, Dave and Erin are Members.
-- Home B: Bob is the Owner, Finn a Member. Bob and Finn are outsiders to Home A.
-- Everything goes through the public functions; capabilities and transfers are out of the API's
-- reach, and memberships still have no direct write path.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'erin@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'finn@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'gina@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Elders', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('gina'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('dave'), 'member'),
  ((select id from ids where name = 'home-a'), tests.user_id('erin'), 'member'),
  ((select id from ids where name = 'home-b'), tests.user_id('finn'), 'member');
insert into ids
  select 'm-' || split_part(u.email, '@', 1) || '-' || case h.name when 'home-a' then 'a' else 'b' end,
    m.id
  from public.home_memberships m
  join auth.users u on u.id = m.user_id
  join ids h on h.id = m.home_id;

-- Join request and accepted email invitation for Dave, to check what departure forgets.
insert into private.home_invitations (
  id, home_id, kind, role, recipient_email, email_locale, token, expires_at, max_admissions,
  admissions, created_by, creation_request_id
) values (
  '41000000-0000-4000-8000-000000000001', (select id from ids where name = 'home-a'), 'email',
  'member', 'dave@madeora.test', 'en', 'dave-token-0000000000000000000000000000000000',
  now() + interval '7 days', 1, 1, tests.user_id('alice'), gen_random_uuid()
);
insert into private.home_join_requests (
  home_id, invitation_id, applicant_id, role, status, applicant_email, applicant_name, decided_at,
  decided_by
) values (
  (select id from ids where name = 'home-a'), '41000000-0000-4000-8000-000000000001',
  tests.user_id('dave'), 'member', 'approved', 'dave@madeora.test', 'Dave D', now(),
  tests.user_id('alice')
), (
  -- An earlier request that was declined still holds his email and name.
  (select id from ids where name = 'home-a'), '41000000-0000-4000-8000-000000000001',
  tests.user_id('dave'), 'member', 'declined', 'dave@madeora.test', 'Dave D', now(),
  tests.user_id('alice')
);

-- Out of the API's reach ----------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  'select capability from private.home_admin_capabilities',
  'Capabilities are not readable through the API'
);
select tests.assert_denied(
  'select status from private.home_ownership_transfers',
  'Ownership transfers are not readable through the API'
);
select tests.assert_denied(
  $$select private.has_home_capability(gen_random_uuid(), auth.uid(), 'removeMembers')$$,
  'The capability helper that takes an account id cannot be called through the API'
);
select tests.assert_denied(
  $$update public.home_memberships set role = 'administrator'
    where id = (select id from ids where name = 'm-dave-a')$$,
  'Memberships still cannot be changed directly'
);
select tests.assert_denied(
  $$delete from public.home_memberships where id = (select id from ids where name = 'm-dave-a')$$,
  'Memberships still cannot be deleted directly'
);
select tests.act_as_anon();
select tests.assert_denied(
  $$select public.leave_home((select id from ids where name = 'home-a'))$$,
  'A signed-out visitor cannot call the S12 functions'
);
select tests.assert_denied(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$,
  'A signed-out visitor cannot read capabilities'
);
select tests.act_as('bob');
select tests.assert_denied(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$,
  'An outsider cannot read another Home''s capabilities'
);
select tests.assert_denied(
  $$select * from public.home_ownership_transfer((select id from ids where name = 'home-a'))$$,
  'An outsider cannot read another Home''s transfer'
);

-- Capabilities ------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-gina-a'),
    array['removeMembers']
  ) = 'not_permitted',
  'An Administrator cannot grant capabilities, not even to another Administrator'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    array['removeMembers']
  ) = 'not_permitted',
  'An Administrator cannot grant capabilities to themselves'
);
select tests.act_as('bob');
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    array['removeMembers']
  ) = 'not_found',
  'An outsider''s grant is refused as not found, revealing nothing'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-b'), (select id from ids where name = 'm-carol-a'),
    array['removeMembers']
  ) = 'not_found',
  'A membership of another Home cannot be addressed through one''s own Home (forged id)'
);

select tests.act_as('alice');
select tests.assert_row_count(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$, 0,
  'A new Administrator starts with no capabilities'
);
select tests.assert_denied(
  $$select public.set_administrator_capabilities((select id from ids where name = 'home-a'),
    (select id from ids where name = 'm-carol-a'), array['deleteHome'])$$,
  'An unknown capability is refused',
  '22023'
);
select tests.assert_denied(
  $$select public.set_administrator_capabilities((select id from ids where name = 'home-a'),
    (select id from ids where name = 'm-carol-a'), array['removeMembers', 'removeMembers'])$$,
  'A repeated capability is refused',
  '22023'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'),
    array['removeMembers']
  ) = 'stale',
  'A Member cannot hold capabilities'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-alice-a'),
    array['removeMembers']
  ) = 'not_permitted',
  'The Owner''s own membership takes no capabilities'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    array['removeMembers', 'manageHomeSettings']
  ) = 'ok',
  'The Owner grants Carol two capabilities'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    array['manageHomeSettings', 'removeMembers']
  ) = 'unchanged',
  'The same set in another order changes nothing'
);
select tests.assert_row_count(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$, 2,
  'The Owner sees every Administrator''s grants'
);
select tests.assert_row_count(
  $$select membership_id from public.home_capabilities((select id from ids where name = 'home-a'))
    where membership_id <> (select id from ids where name = 'm-carol-a')$$, 0,
  'Rows carry membership ids, only Carol''s'
);

select tests.act_as('gina');
select tests.assert_row_count(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$, 0,
  'Another Administrator sees only their own grants (none)'
);
select tests.act_as('carol');
select tests.assert_row_count(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))
    where is_self$$, 2,
  'Carol sees her own two grants'
);
select tests.act_as('dave');
select tests.assert_row_count(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$, 0,
  'A Member sees no grants'
);

-- Home settings follow manageHomeSettings.
select tests.act_as('carol');
select tests.assert_row_count(
  $$update public.homes set name = 'Thuis 2' where id = (select id from ids where name = 'home-a')
    returning id$$, 1,
  'An Administrator with manageHomeSettings renames the Home'
);
select tests.act_as('gina');
select tests.assert_row_count(
  $$update public.homes set name = 'Gina was here' where id = (select id from ids where name = 'home-a')
    returning id$$, 0,
  'An Administrator without manageHomeSettings cannot'
);
select tests.act_as('dave');
select tests.assert_row_count(
  $$update public.homes set name = 'Dave was here' where id = (select id from ids where name = 'home-a')
    returning id$$, 0,
  'A Member cannot'
);

-- Invitations follow manageInvitations, Member role only.
select tests.act_as('gina');
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', gen_random_uuid(), null, null, '7d', 1)) = 'not_permitted',
  'An Administrator without manageInvitations cannot invite'
);
select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-gina-a'),
    array['manageInvitations']
  ) = 'ok',
  'The Owner grants Gina manageInvitations'
);
select tests.act_as('gina');
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'administrator', gen_random_uuid(), null, null, '7d', 1)) = 'not_permitted',
  'manageInvitations never reaches Administrator invitations'
);
insert into ids select 'gina-link-request', gen_random_uuid();
select tests.assert_true(
  (select outcome from public.create_home_invitation((select id from ids where name = 'home-a'),
    'link', 'member', (select id from ids where name = 'gina-link-request'), null, null, '7d', 1))
    = 'created',
  'An Administrator with manageInvitations invites Members'
);
-- The Owner's Administrator link, and Finn applying through it, stay out of Gina's sight.
select tests.act_as('alice');
insert into ids select 'admin-link', invitation_id from public.create_home_invitation(
  (select id from ids where name = 'home-a'), 'link', 'administrator', gen_random_uuid(), null,
  null, '7d', 1);
select tests.act_as_owner();
insert into private.home_join_requests (home_id, invitation_id, applicant_id, role, applicant_email,
  applicant_name)
values ((select id from ids where name = 'home-a'), (select id from ids where name = 'admin-link'),
  tests.user_id('finn'), 'administrator', 'finn@madeora.test', 'Finn F');
select tests.act_as('gina');
select tests.assert_true(
  not exists (
    select 1 from public.list_home_invitations((select id from ids where name = 'home-a'))
    where role = 'administrator'
  ) and exists (
    select 1 from public.list_home_invitations((select id from ids where name = 'home-a'))
    where role = 'member'
  ),
  'An Administrator with manageInvitations lists Member invitations only, never Administrator links'
);
select tests.assert_true(
  not exists (
    select 1 from public.list_home_join_requests((select id from ids where name = 'home-a'))
    where role = 'administrator' or applicant_email = 'finn@madeora.test'
  ),
  'nor requests to become Administrator, with their email and name'
);
select tests.act_as('alice');
select tests.assert_true(
  exists (
    select 1 from public.list_home_invitations((select id from ids where name = 'home-a'))
    where id = (select id from ids where name = 'admin-link') and token is not null
  ) and exists (
    select 1 from public.list_home_join_requests((select id from ids where name = 'home-a'))
    where role = 'administrator' and applicant_email = 'finn@madeora.test'
  ),
  'The Owner still sees both'
);
select tests.act_as_owner();
delete from private.home_join_requests where applicant_id = tests.user_id('finn');
select tests.act_as_owner();
insert into ids select 'gina-link', i.id from private.home_invitations i
  where i.creation_request_id = (select id from ids where name = 'gina-link-request');
select tests.assert_true(
  (select private.invitation_state(i) from private.home_invitations i
    where i.id = (select id from ids where name = 'gina-link')) = 'active',
  'Gina''s invitation is active'
);
select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-gina-a'),
    array[]::text[]
  ) = 'ok',
  'The Owner revokes all of Gina''s capabilities'
);
select tests.act_as_owner();
select tests.assert_true(
  (select private.invitation_state(i) from private.home_invitations i
    where i.id = (select id from ids where name = 'gina-link')) = 'invalid',
  'Revoking the grant makes Gina''s invitation unusable at once'
);
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'home_membership.capabilities_changed'
      and e.home_id = (select id from ids where name = 'home-a')
      and e.subject_id = tests.user_id('gina')
      and e.details = '{"from": ["manageInvitations"], "to": []}'::jsonb) = 1,
  'The capability change is audited with the previous and new sets'
);
select tests.assert_true(
  not exists (
    select 1 from private.audit_events e
    where e.home_id = (select id from ids where name = 'home-a')
      and (e.details::text ilike '%@%' or e.details::text ilike '%Dave D%')
  ),
  'No audit row holds an email address or a name'
);
select tests.assert_denied(
  $$insert into private.home_admin_capabilities (home_id, user_id, capability)
    values ((select id from ids where name = 'home-a'), tests.user_id('dave'), 'removeMembers')$$,
  'Even the database owner cannot give a Member a capability',
  '23514'
);

-- Roles -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  public.change_home_member_role(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'),
    'administrator', 'member'
  ) = 'not_permitted',
  'An Administrator cannot promote anyone (assigning Administrators is Owner-only)'
);
select tests.act_as('alice');
select tests.assert_denied(
  $$select public.change_home_member_role((select id from ids where name = 'home-a'),
    (select id from ids where name = 'm-dave-a'), 'owner', 'member')$$,
  'Nobody becomes Owner through a role change',
  '22023'
);
select tests.assert_true(
  public.change_home_member_role(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-alice-a'),
    'member', 'member'
  ) in ('not_permitted', 'stale'),
  'The Owner cannot demote themselves'
);
select tests.assert_true(
  public.change_home_member_role(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'),
    'member', 'administrator'
  ) = 'stale',
  'A role change made from an outdated view is refused'
);
select tests.assert_true(
  public.change_home_member_role(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    'member', 'administrator'
  ) = 'ok',
  'The Owner demotes Carol to Member'
);
select tests.assert_row_count(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$, 0,
  'Demotion drops every grant'
);
select tests.assert_true(
  public.change_home_member_role(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    'administrator', 'member'
  ) = 'ok',
  'The Owner promotes Carol again'
);
select tests.assert_row_count(
  $$select * from public.home_capabilities((select id from ids where name = 'home-a'))$$, 0,
  'A re-promoted Administrator starts again from no capabilities'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    array['removeMembers']
  ) = 'ok',
  'The Owner grants Carol removeMembers'
);

-- Removal -----------------------------------------------------------------------------------------

select tests.act_as('gina');
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-erin-a'), 'member'
  ) = 'not_permitted',
  'An Administrator without removeMembers cannot remove a Member'
);
select tests.act_as('erin');
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'), 'member'
  ) = 'not_permitted',
  'A Member cannot remove anyone'
);
select tests.act_as('bob');
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'), 'member'
  ) = 'not_found',
  'An outsider cannot remove anyone and learns nothing'
);
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-b'), (select id from ids where name = 'm-dave-a'), 'member'
  ) = 'not_found',
  'A membership of another Home cannot be removed through one''s own Home (forged id)'
);
select tests.act_as('carol');
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-gina-a'),
    'administrator'
  ) = 'not_permitted',
  'An Administrator with removeMembers cannot remove another Administrator'
);
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-alice-a'), 'owner'
  ) = 'not_permitted',
  'An Administrator cannot remove the Owner'
);
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    'administrator'
  ) = 'not_permitted',
  'Nobody removes themselves (that is leaving)'
);
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'),
    'administrator'
  ) = 'stale',
  'A removal confirmed from an outdated view is refused'
);

-- Dave can see the Home before the removal.
select tests.act_as('dave');
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-a')$$, 1,
  'Dave sees Home A before the removal'
);
select tests.act_as('carol');
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'), 'member'
  ) = 'removed',
  'An Administrator with removeMembers removes a Member'
);
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-dave-a'), 'member'
  ) = 'not_found',
  'Repeating the removal is reported as already removed, never repeated'
);
select tests.act_as('dave');
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-a')$$, 0,
  'The removed Member loses access to the Home at once'
);
select tests.assert_row_count(
  $$select id from public.home_memberships where home_id = (select id from ids where name = 'home-a')$$,
  0,
  'and to their membership'
);
select tests.assert_denied(
  $$select * from public.home_directory((select id from ids where name = 'home-a'))$$,
  'and to the member directory'
);
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'not_found',
  'A removed person cannot act in the Home any more'
);
select tests.act_as_owner();
select tests.assert_true(
  not exists (
    select 1 from private.home_join_requests r where r.applicant_id = tests.user_id('dave')
  ) and not exists (
    select 1 from private.home_invitations i where i.recipient_email = 'dave@madeora.test'
  ),
  'The departed member''s email and name snapshots are gone from join requests and invitations'
);
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'home_membership.removed' and e.subject_id = tests.user_id('dave')
      and e.actor_user_id = tests.user_id('carol')) = 1,
  'The removal is audited with the remover as actor'
);

select tests.act_as('alice');
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-gina-a'),
    'administrator'
  ) = 'removed',
  'The Owner removes an Administrator'
);
select tests.act_as_owner();
select tests.assert_true(
  not exists (
    select 1 from private.home_admin_capabilities c where c.user_id = tests.user_id('gina')
  ),
  'A removed Administrator''s grants end with the membership'
);

-- Leaving -----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'owner_must_transfer',
  'The Owner cannot leave'
);
select tests.act_as('finn');
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'not_found',
  'Leaving a Home you are not in does nothing'
);
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-b')) = 'left',
  'A Member leaves without anyone''s approval'
);
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-b')$$, 0,
  'and loses access at once'
);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'home_membership.left' and e.subject_id = tests.user_id('finn')) = 1,
  'Leaving is audited as left'
);

-- Ownership transfer ------------------------------------------------------------------------------
-- Home A now: Alice Owner, Carol Administrator (removeMembers), Erin Member.

select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.start_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'm-erin-a'), gen_random_uuid())) = 'not_permitted',
  'An Administrator cannot start a transfer'
);
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.start_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'm-alice-a'), gen_random_uuid())) = 'invalid_target',
  'The Owner cannot nominate themselves'
);
select tests.assert_true(
  (select outcome from public.start_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'm-bob-b'), gen_random_uuid())) = 'not_found',
  'The Owner cannot nominate someone outside the Home'
);
insert into ids select 'transfer-request-1', gen_random_uuid();
insert into ids
  select 'transfer-1', transfer_id from public.start_ownership_transfer(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-erin-a'),
    (select id from ids where name = 'transfer-request-1'));
select tests.assert_true(
  (select transfer_id from public.start_ownership_transfer(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-erin-a'),
    (select id from ids where name = 'transfer-request-1')))
    = (select id from ids where name = 'transfer-1'),
  'Repeating the start request returns the same transfer'
);
select tests.assert_true(
  (select outcome from public.start_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'm-carol-a'), gen_random_uuid())) = 'pending_exists',
  'Only one transfer can be pending per Home'
);
select tests.assert_true(
  (select state from public.home_ownership_transfer((select id from ids where name = 'home-a'))
    where is_sender) = 'pending',
  'The Owner sees the pending transfer'
);
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'owner_must_transfer',
  'A pending transfer does not let the Owner leave'
);
select tests.act_as('carol');
select tests.assert_row_count(
  $$select * from public.home_ownership_transfer((select id from ids where name = 'home-a'))$$, 0,
  'Other members do not see the transfer'
);
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-1'), 'accept') = 'not_found',
  'Only the nominated member can accept'
);
select tests.assert_true(
  public.cancel_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-1')) = 'not_found',
  'Only the Owner who started it can cancel'
);

select tests.act_as('erin');
select tests.assert_true(
  (select state from public.home_ownership_transfer((select id from ids where name = 'home-a'))
    where is_recipient) = 'pending',
  'The nominated member sees the request'
);
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-1'), 'decline') = 'declined',
  'Erin declines'
);
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-1'), 'accept') = 'already_decided',
  'A declined transfer cannot be accepted afterwards'
);
select tests.act_as('alice');
select tests.assert_true(
  (select state from public.home_ownership_transfer((select id from ids where name = 'home-a'))) = 'declined',
  'The Owner sees that it was declined'
);
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'owner_must_transfer',
  'A declined transfer does not let the Owner leave'
);

-- Cancel.
insert into ids
  select 'transfer-2', transfer_id from public.start_ownership_transfer(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-erin-a'),
    gen_random_uuid());
select tests.assert_true(
  public.cancel_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-2')) = 'cancelled',
  'The Owner cancels a pending transfer'
);
select tests.act_as('erin');
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-2'), 'accept') = 'already_decided',
  'A cancelled transfer cannot be accepted'
);

-- Expiry.
select tests.act_as('alice');
insert into ids
  select 'transfer-3', transfer_id from public.start_ownership_transfer(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-erin-a'),
    gen_random_uuid());
select tests.act_as_owner();
update private.home_ownership_transfers set created_at = now() - interval '8 days',
  expires_at = now() - interval '1 day'
  where id = (select id from ids where name = 'transfer-3');
select tests.act_as('erin');
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-3'), 'accept') = 'expired',
  'An expired transfer cannot be accepted'
);

-- The recipient leaves before accepting.
select tests.act_as('alice');
insert into ids
  select 'transfer-4', transfer_id from public.start_ownership_transfer(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-erin-a'),
    gen_random_uuid());
select tests.act_as('carol');
select tests.assert_true(
  public.remove_home_member(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-erin-a'), 'member'
  ) = 'removed',
  'The nominated Member is removed while the transfer is pending'
);
select tests.act_as('erin');
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-4'), 'accept') = 'not_found',
  'A removed recipient cannot accept'
);
select tests.act_as('alice');
select tests.assert_true(
  (select state from public.home_ownership_transfer((select id from ids where name = 'home-a'))) = 'invalid',
  'The Owner sees the transfer became invalid'
);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'home_ownership.transfer_invalid'
      and e.subject_id = (select id from ids where name = 'transfer-4')) = 1,
  'The transfer becoming invalid through the removal is audited'
);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from public.home_memberships m
    where m.home_id = (select id from ids where name = 'home-a') and m.role = 'owner'
      and m.user_id = tests.user_id('alice')) = 1,
  'Declined, cancelled, expired and invalid transfers leave Alice the only Owner'
);

-- Acceptance.
select tests.act_as('alice');
insert into ids
  select 'transfer-5', transfer_id from public.start_ownership_transfer(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    gen_random_uuid());
select tests.act_as('carol');
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-5'), 'accept') = 'accepted',
  'Carol accepts'
);
select tests.act_as_owner();
set constraints all immediate;
select tests.assert_true(
  (select array_agg(u.email || ':' || m.role order by u.email) from public.home_memberships m
    join auth.users u on u.id = m.user_id
    where m.home_id = (select id from ids where name = 'home-a'))
    = array['alice@madeora.test:member', 'carol@madeora.test:owner'],
  'Acceptance makes Carol the only Owner and Alice a Member'
);
set constraints all deferred;
select tests.assert_true(
  not exists (
    select 1 from private.home_admin_capabilities c where c.user_id = tests.user_id('carol')
  ),
  'The new Owner''s Administrator grants are dropped'
);
select tests.assert_true(
  (select count(*) from private.audit_events e
    where e.action = 'home_ownership.transfer_accepted'
      and e.home_id = (select id from ids where name = 'home-a')
      and e.actor_user_id = tests.user_id('carol')) = 1,
  'Acceptance is audited'
);
select tests.act_as('alice');
select tests.assert_true(
  public.respond_to_ownership_transfer((select id from ids where name = 'home-a'),
    (select id from ids where name = 'transfer-5'), 'accept') = 'not_found',
  'The former Owner cannot act on the finished transfer'
);
select tests.assert_true(
  public.set_administrator_capabilities(
    (select id from ids where name = 'home-a'), (select id from ids where name = 'm-carol-a'),
    array['removeMembers']
  ) = 'not_permitted',
  'The former Owner has lost every Owner power'
);
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'left',
  'After the accepted transfer the former Owner may leave'
);
select tests.act_as('carol');
select tests.assert_true(
  public.leave_home((select id from ids where name = 'home-a')) = 'owner_must_transfer',
  'The new Owner cannot leave without a transfer either'
);
