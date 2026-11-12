-- S41: child profiles and guardians (supabase/migrations/20261129090000_child_profiles.sql).
-- Guardian boundaries: who may create a child, assign and remove guardians, change presets and
-- presentation, read child settings, and remove a child; children are always Members, cannot hold
-- guardian or Owner authority, and guardianship in one Home grants nothing in another.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated;

create function tests.ch(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.ch_account(p_email text) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (v_id, 'authenticated', 'authenticated', p_email,
              '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000',
              now(), '{}', '{}', now(), now());
    return v_id;
  end
  $$;

-- The membership id of a user in a Home, whoever is acting.
create function tests.ch_mid(p_home uuid, p_user uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select m.id from private.home_memberships_all m where m.home_id = p_home and m.user_id = p_user
  $$;

-- The open guardian offer to a user for a child, whoever is acting.
create function tests.ch_offer(p_child_membership uuid, p_guardian uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select o.id from public.child_guardian_offers o
    join private.home_memberships_all m on m.home_id = o.home_id and m.user_id = o.child_user_id
    where m.id = p_child_membership and o.guardian_user_id = p_guardian
  $$;

grant execute on function tests.ch(text), tests.ch_mid(uuid, uuid), tests.ch_offer(uuid, uuid)
  to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A, with Bob (Member), Carol (Administrator without capabilities) and
-- Dave (Member). Erin owns Home B and is in no other Home.
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob')),
  ('carol', tests.user_id('carol'));
insert into ids values ('dave', tests.ch_account('dave@child-test.madeora.test')),
  ('erin', tests.ch_account('erin@child-test.madeora.test'));

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_user(tests.ch('erin'));
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.ch('home-a'), tests.ch('bob'), 'member'),
  (tests.ch('home-a'), tests.ch('carol'), 'administrator'),
  (tests.ch('home-a'), tests.ch('dave'), 'member');
insert into ids values
  ('m-alice', tests.ch_mid(tests.ch('home-a'), tests.ch('alice'))),
  ('m-bob', tests.ch_mid(tests.ch('home-a'), tests.ch('bob'))),
  ('m-carol', tests.ch_mid(tests.ch('home-a'), tests.ch('carol'))),
  ('m-dave', tests.ch_mid(tests.ch('home-a'), tests.ch('dave'))),
  ('m-erin-b', tests.ch_mid(tests.ch('home-b'), tests.ch('erin')));
insert into ids values ('req-1', gen_random_uuid());

-- Creating a child ---------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.create_child(tests.ch('home-a'), 'Mia', tests.ch('m-bob'), null,
    '#16a34a', gen_random_uuid())$$,
  'A signed-out visitor cannot create a child'
);

select tests.act_as_user(tests.ch('erin'));
select tests.assert_true(
  (select outcome from public.create_child(tests.ch('home-a'), 'Mia', tests.ch('m-bob'), null,
     '#16a34a', gen_random_uuid())) = 'not_found',
  'Someone outside the Home cannot add a child to it'
);

select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.create_child(tests.ch('home-a'), 'Mia', tests.ch('m-dave'), null,
     '#16a34a', gen_random_uuid())) = 'not_permitted',
  'A plain Member cannot make someone else primary guardian'
);
select tests.assert_denied(
  $$select * from public.create_child(tests.ch('home-a'), E'Mi​a', tests.ch('m-bob'), null,
    '#16a34a', gen_random_uuid())$$,
  'A child name follows the visible-name rule',
  '22023'
);
select tests.assert_denied(
  $$select * from public.create_child(tests.ch('home-a'), 'Mia', tests.ch('m-bob'), '18_plus',
    '#16a34a', gen_random_uuid())$$,
  'Only the three age bands are accepted',
  '22023'
);
insert into ids select 'm-mia', membership_id from public.create_child(
  tests.ch('home-a'), 'Mia', tests.ch('m-bob'), 'under_8', '#16a34a', tests.ch('req-1'));
select tests.assert_true(tests.ch('m-mia') is not null,
  'A Member can add a child with themselves as primary guardian');
select tests.assert_true(
  (select membership_id from public.create_child(tests.ch('home-a'), 'Mia', tests.ch('m-bob'),
     'under_8', '#16a34a', tests.ch('req-1'))) = tests.ch('m-mia'),
  'Retrying the same request returns the same child, not a second one'
);

select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.create_child(tests.ch('home-a'), 'Noor', tests.ch('m-dave'), null,
     '#2563eb', gen_random_uuid())) = 'not_permitted',
  'An Administrator without manageInvitations cannot name another guardian'
);

select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.create_child(tests.ch('home-a'), 'Noor', tests.ch('m-mia'), null,
     '#2563eb', gen_random_uuid())) = 'invalid_guardian',
  'A child cannot be a guardian'
);
select tests.assert_true(
  (select outcome from public.create_child(tests.ch('home-a'), 'Noor', tests.ch('m-erin-b'), null,
     '#2563eb', gen_random_uuid())) = 'invalid_guardian',
  'A guardian must be a member of this Home (a membership id from another Home is refused)'
);
insert into ids select 'm-noor', membership_id from public.create_child(
  tests.ch('home-a'), 'Noor', tests.ch('m-dave'), null, '#2563eb', gen_random_uuid());
select tests.assert_true(tests.ch('m-noor') is not null,
  'The Owner can add a child naming another adult member as primary guardian');
select tests.assert_true(
  (select primary_guardian_membership_id is null
     and pending_primary_membership_id = tests.ch('m-dave') and preset is null
   from public.home_children(tests.ch('home-a')) where membership_id = tests.ch('m-noor')),
  'Until the named adult accepts, the child has no primary guardian and the Owner no access'
);

select tests.act_as_owner();
insert into ids
  select 'mia', m.user_id from private.home_memberships_all m where m.id = tests.ch('m-mia');
insert into ids
  select 'noor', m.user_id from private.home_memberships_all m where m.id = tests.ch('m-noor');

-- Guardian offers need the named adult's acceptance.
select tests.act_as_user(tests.ch('erin'));
select tests.assert_true(
  public.answer_child_guardian_offer(tests.ch_offer(tests.ch('m-noor'), tests.ch('dave')), true)
    = 'not_found',
  'Nobody else can accept an offer made to Dave'
);
select tests.act_as_user(tests.ch('dave'));
select tests.assert_row_count('select 1 from public.child_home_settings', 0,
  'An adult with an unanswered offer has no guardian access');
select tests.assert_row_count(
  $$select 1 from public.my_child_guardian_offers(tests.ch('home-a')) where kind = 'initial'$$, 1,
  'Dave sees the offer made to him'
);
select tests.assert_true(
  public.answer_child_guardian_offer(tests.ch_offer(tests.ch('m-noor'), tests.ch('dave')), true)
    = 'accepted',
  'Dave accepts and becomes primary guardian'
);
select tests.assert_row_count('select 1 from public.child_home_settings', 1,
  'After accepting, Dave reads the child''s settings');

select tests.act_as_owner();

-- The identity -------------------------------------------------------------------------------------

select tests.assert_true(
  (select u.email is null and u.encrypted_password = '' and u.email_confirmed_at is null
   from auth.users u where u.id = tests.ch('mia')),
  'A child identity has no email, no password and is not confirmed'
);
select tests.assert_true(
  not exists (select 1 from auth.identities i where i.user_id = tests.ch('mia')),
  'A child identity has no sign-in identity'
);
select tests.assert_true(
  (select role from private.home_memberships_all where id = tests.ch('m-mia')) = 'member'
  and (select preset from public.child_home_settings where child_user_id = tests.ch('mia'))
    = 'young_child',
  'A new child is a Member on the Young Child preset'
);
select tests.assert_true(
  exists (select 1 from private.audit_events a
          where a.action = 'child.created' and a.subject_id = tests.ch('mia')),
  'Creating a child is audited'
);
select tests.assert_true(
  not private.can_receive_notifications(tests.ch('mia')),
  'A child receives no notifications or email'
);
select tests.assert_denied(
  $$update private.home_memberships_all set role = 'administrator' where id = tests.ch('m-mia')$$,
  'A child can never become an Administrator, even for the database owner',
  '23514'
);

select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.start_ownership_transfer(tests.ch('home-a'), tests.ch('m-mia'),
     gen_random_uuid())) = 'invalid_target',
  'Ownership cannot be offered to a child'
);

-- Who sees what ------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select preset = 'young_child' and capabilities = array['viewHomeCalendar', 'viewHomeChores',
     'viewLeaderboard'] and age_band = 'under_8' and my_guardian_role = 'primary'
   from public.home_children(tests.ch('home-a')) where membership_id = tests.ch('m-mia')),
  'The primary guardian sees the preset, effective capabilities and age band'
);
select tests.assert_row_count('select 1 from public.child_home_settings', 1,
  'Bob reads only the settings of the child he guards');
select tests.assert_row_count('select 1 from public.child_profiles', 1,
  'Bob reads only the identity row of the child he guards');
select tests.assert_true(
  (select is_child from public.home_directory(tests.ch('home-a'))
   where membership_id = tests.ch('m-mia')),
  'The directory marks the child'
);

select tests.act_as('carol');
select tests.assert_true(
  (select preset is null and capabilities is null and age_band is null and overrides is null
     and my_guardian_role is null and primary_guardian_membership_id = tests.ch('m-bob')
   from public.home_children(tests.ch('home-a')) where membership_id = tests.ch('m-mia')),
  'A non-guardian Administrator sees the guardians but not the child''s access or age band'
);
select tests.assert_row_count('select 1 from public.child_home_settings', 0,
  'A non-guardian reads no child settings');
select tests.assert_row_count('select 1 from public.child_profiles', 0,
  'A non-guardian reads no child identity rows');
select tests.assert_row_count('select 1 from public.child_guardians', 2,
  'Every member sees who the guardians are');

select tests.act_as_user(tests.ch('erin'));
select tests.assert_denied(
  $$select * from public.home_children(tests.ch('home-a'))$$,
  'Someone outside the Home cannot list its children'
);
select tests.assert_row_count('select 1 from public.child_guardians', 0,
  'Someone outside the Home sees no guardian assignments');

select tests.act_as('bob');
select tests.assert_denied(
  $$insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role)
    values (tests.ch('home-a'), tests.ch('noor'), tests.ch('bob'), 'secondary')$$,
  'Nobody writes guardian assignments directly'
);
select tests.assert_denied(
  $$update public.child_home_settings set preset = 'teen'$$,
  'Nobody writes child settings directly'
);
select tests.assert_denied(
  $$update public.child_profiles set age_band = '13_17'$$,
  'Nobody writes child identity rows directly'
);

-- Guardian assignments -----------------------------------------------------------------------------

select tests.act_as_user(tests.ch('dave'));
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-dave'),
    'secondary') = 'not_permitted',
  'A non-guardian cannot make themselves secondary guardian'
);
select tests.act_as('alice');
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-alice'),
    'secondary') = 'not_permitted',
  'Being Owner does not grant guardian authority over a child that has a primary guardian'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-alice'),
    'primary') = 'not_permitted',
  'The Owner cannot take over the primary role while one exists'
);
select tests.act_as('bob');
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-bob'),
    'secondary') = 'invalid_guardian',
  'The primary guardian cannot also be secondary'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-noor'),
    'secondary') = 'invalid_guardian',
  'A child cannot be made a guardian'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-erin-b'),
    'secondary') = 'invalid_guardian',
  'A forged membership id from another Home is refused'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-dave'), tests.ch('m-carol'),
    'secondary') = 'not_found',
  'An adult''s membership is not a child'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-dave'),
    'secondary') = 'offered',
  'The primary guardian offers the secondary role'
);
select tests.act_as_user(tests.ch('dave'));
select tests.assert_true(
  public.answer_child_guardian_offer(tests.ch_offer(tests.ch('m-mia'), tests.ch('dave')), true)
    = 'accepted',
  'Dave accepts the secondary role'
);
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.audit_events a
          where a.action = 'child.guardian_assigned' and a.subject_id = tests.ch('mia')),
  'Guardian assignments are audited'
);

-- Secondary guardian limits ------------------------------------------------------------------------

select tests.act_as_user(tests.ch('dave'));
select tests.assert_true(
  (select my_guardian_role from public.home_children(tests.ch('home-a'))
   where membership_id = tests.ch('m-mia')) = 'secondary',
  'Dave is now the secondary guardian'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-dave'),
    'primary') = 'not_permitted',
  'A secondary guardian cannot promote themselves'
);
select tests.assert_true(
  (select outcome from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'), 'child',
     '{}', true, (select settings_updated_at from public.home_children(tests.ch('home-a'))
                  where membership_id = tests.ch('m-mia')))) = 'not_permitted',
  'A secondary guardian cannot change the preset'
);
select tests.assert_true(
  (select outcome from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'),
     'young_child', '{"redeemRewards": true}', true,
     (select settings_updated_at from public.home_children(tests.ch('home-a'))
      where membership_id = tests.ch('m-mia')))) = 'not_permitted',
  'A secondary guardian cannot widen access with an override'
);
select tests.assert_true(
  (select outcome from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'),
     'young_child', '{"viewLeaderboard": false}', false,
     (select settings_updated_at from public.home_children(tests.ch('home-a'))
      where membership_id = tests.ch('m-mia')))) = 'saved',
  'A secondary guardian can switch a capability off'
);

-- Primary guardian presets -------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'),
     'young_child', '{}', false, '2000-01-01 00:00:00+00')) = 'stale',
  'A write based on a stale read is refused (two guardians editing at once)'
);
select tests.assert_denied(
  $$select * from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'), 'young_child',
    '{"adminEverything": true}', true, now())$$,
  'Unknown capabilities are refused',
  '22023'
);
select tests.assert_true(
  (select outcome = 'confirmation_required' and not (before_capabilities @> after_capabilities)
   from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'), 'teen', '{}', false,
     (select settings_updated_at from public.home_children(tests.ch('home-a'))
      where membership_id = tests.ch('m-mia')))),
  'Widening access needs explicit confirmation after the preview'
);
select tests.assert_true(
  (select outcome = 'saved' and 'editShopping' = any (after_capabilities)
   from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'), 'teen',
     '{"viewLeaderboard": false}', true,
     (select settings_updated_at from public.home_children(tests.ch('home-a'))
      where membership_id = tests.ch('m-mia')))),
  'The primary guardian changes the preset and keeps the explicit override'
);
select tests.assert_true(
  (select not ('viewLeaderboard' = any (capabilities))
   from public.home_children(tests.ch('home-a')) where membership_id = tests.ch('m-mia')),
  'The override still applies on the new preset'
);
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.audit_events a
          where a.action = 'child.access_changed' and a.subject_id = tests.ch('mia')
            and a.details ->> 'preset_after' = 'teen'),
  'Preset changes are audited with before and after'
);
select tests.assert_true(
  private.child_has_capability(tests.ch('home-a'), tests.ch('mia'), 'editShopping')
  and not private.child_has_capability(tests.ch('home-a'), tests.ch('mia'), 'viewLeaderboard'),
  'The capability check follows preset and overrides'
);

-- Presentation -------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  public.set_child_presentation(tests.ch('home-a'), tests.ch('m-mia'), 'Mimi', '#dc2626')
    = 'not_permitted',
  'A non-guardian cannot rename a child or change their colour'
);
select tests.act_as_user(tests.ch('dave'));
select tests.assert_true(
  public.set_child_presentation(tests.ch('home-a'), tests.ch('m-mia'), 'Mimi', '#dc2626')
    = 'saved',
  'A secondary guardian manages the child''s name and colour in this Home'
);
select tests.assert_true(
  (select name = 'Mimi' and accent_color = '#dc2626' from public.home_directory(tests.ch('home-a'))
   where membership_id = tests.ch('m-mia')),
  'The directory shows the new name and colour'
);
select tests.assert_true(
  public.set_child_presentation(tests.ch('home-a'), tests.ch('m-mia'), '', '#dc2626') = 'saved',
  'A guardian can clear the child''s Home name'
);
select tests.assert_true(
  (select name = 'Mia' from public.home_directory(tests.ch('home-a'))
   where membership_id = tests.ch('m-mia')),
  'An empty Home name falls back to the name given at creation'
);

-- Handing over the primary role -------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-dave'),
    'primary') = 'offered',
  'The primary guardian offers the primary role to the secondary guardian'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-carol'),
    'secondary') = 'offered',
  'Bob, still primary, also offers the secondary role to Carol'
);
select tests.act_as_user(tests.ch('dave'));
select tests.assert_true(
  public.answer_child_guardian_offer(tests.ch_offer(tests.ch('m-mia'), tests.ch('dave')), true)
    = 'accepted',
  'Dave accepts the primary role'
);
select tests.act_as('carol');
select tests.assert_true(
  public.answer_child_guardian_offer(tests.ch_offer(tests.ch('m-mia'), tests.ch('carol')), true)
    = 'no_longer_valid',
  'An offer whose maker is no longer primary guardian cannot be accepted'
);
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.audit_events a
          where a.action = 'child.guardian_ended' and a.subject_id = tests.ch('mia')),
  'Ending a guardian role is audited'
);
select tests.act_as('bob');
select tests.assert_true(
  (select my_guardian_role = 'secondary' and primary_guardian_membership_id = tests.ch('m-dave')
   from public.home_children(tests.ch('home-a')) where membership_id = tests.ch('m-mia')),
  'The previous primary guardian becomes secondary'
);
select tests.assert_true(
  public.remove_child_secondary_guardian(tests.ch('home-a'), tests.ch('m-mia')) = 'removed',
  'A secondary guardian can step down'
);
select tests.assert_row_count('select 1 from public.child_home_settings', 0,
  'After stepping down Bob no longer reads the child''s settings');
select tests.assert_true(
  (select outcome from public.set_child_access(tests.ch('home-a'), tests.ch('m-mia'), 'teen',
     '{}', true, now())) = 'not_permitted',
  'A former guardian has no authority'
);

-- Removing a child ---------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  public.remove_home_member(tests.ch('home-a'), tests.ch('m-mia'), 'member') = 'not_permitted',
  'An Administrator who is not the primary guardian cannot remove a child'
);
select tests.act_as_user(tests.ch('dave'));
select tests.assert_true(
  public.remove_home_member(tests.ch('home-a'), tests.ch('m-mia'), 'member') = 'child_last_home',
  'A child cannot be removed from their only Home'
);

-- On hold: the primary guardian leaves -------------------------------------------------------------

select tests.assert_true(public.leave_home(tests.ch('home-a')) = 'left', 'Dave leaves Home A');
select tests.act_as('bob');
select tests.assert_true(
  (select primary_guardian_membership_id is null from public.home_children(tests.ch('home-a'))
   where membership_id = tests.ch('m-mia')),
  'When the primary guardian leaves, the child has no primary guardian (on hold)'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-bob'),
    'primary') = 'not_permitted',
  'A Member cannot claim a child that is on hold'
);
select tests.act_as('alice');
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-alice'),
    'primary') = 'invalid_guardian',
  'The Owner cannot appoint themselves guardian of a child on hold'
);
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-bob'),
    'primary') = 'offered',
  'The Owner offers the primary role for a child on hold'
);
select tests.act_as('bob');
select tests.assert_true(
  public.answer_child_guardian_offer(tests.ch_offer(tests.ch('m-mia'), tests.ch('bob')), false)
    = 'declined',
  'The named adult can decline'
);
select tests.act_as('alice');
select tests.assert_true(
  public.assign_child_guardian(tests.ch('home-a'), tests.ch('m-mia'), tests.ch('m-bob'),
    'primary') = 'offered',
  'The Owner asks again'
);
select tests.act_as('bob');
select tests.assert_true(
  public.answer_child_guardian_offer(tests.ch_offer(tests.ch('m-mia'), tests.ch('bob')), true)
    = 'accepted',
  'Bob accepts and becomes primary guardian'
);
select tests.act_as('alice');
select tests.assert_true(
  (select preset is null from public.home_children(tests.ch('home-a'))
   where membership_id = tests.ch('m-mia')),
  'Appointing a guardian does not give the Owner guardian access'
);

-- Mistaken creation and limits --------------------------------------------------------------------

select tests.act_as('bob');
insert into ids select 'm-typo', membership_id from public.create_child(
  tests.ch('home-a'), 'Mai', tests.ch('m-bob'), null, '#2563eb', gen_random_uuid());
select tests.act_as_owner();
insert into ids
  select 'typo', m.user_id from private.home_memberships_all m where m.id = tests.ch('m-typo');
select tests.act_as('carol');
select tests.assert_true(
  public.delete_mistaken_child(tests.ch('home-a'), tests.ch('m-typo')) = 'not_permitted',
  'Someone who neither created nor guards the child cannot delete it'
);
select tests.act_as_owner();
update public.child_profiles set created_at = now() - interval '2 days'
  where user_id = tests.ch('typo');
select tests.act_as('bob');
select tests.assert_true(
  public.delete_mistaken_child(tests.ch('home-a'), tests.ch('m-typo')) = 'too_late',
  'Outside the correction window a child cannot be deleted this way'
);
select tests.act_as_owner();
update public.child_profiles set created_at = now() where user_id = tests.ch('typo');
select tests.act_as('bob');
select tests.assert_true(
  (select can_delete from public.home_children(tests.ch('home-a'))
   where membership_id = tests.ch('m-typo')),
  'The creator is offered the correction'
);
select tests.assert_true(
  public.delete_mistaken_child(tests.ch('home-a'), tests.ch('m-typo')) = 'deleted',
  'The creator deletes a child created by mistake'
);
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from auth.users where id = tests.ch('typo')),
  'The mistaken identity is gone'
);

select tests.act_as('carol');
do $$
  declare
    v_outcome text;
    v_created integer := 0;
  begin
    for i in 1..11 loop
      select outcome into v_outcome from public.create_child(
        tests.ch('home-a'), 'Kid ' || i, tests.ch('m-carol'), null, '#2563eb', gen_random_uuid());
      exit when v_outcome <> 'created';
      v_created := v_created + 1;
    end loop;
    perform tests.assert_true(v_created = 10 and v_outcome = 'limit_reached',
      'One account can create at most 10 children per 24 hours');
  end
$$;

-- Per-Home guardianship ----------------------------------------------------------------------------

-- Linking Mia to Home B: Bob (primary in A) issues a code, Erin redeems it in Home B.
create temporary table link (code text) on commit drop;
grant all on link to anon, authenticated;

select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.create_child_link_code(tests.ch('home-a'), tests.ch('m-mia')))
    = 'not_permitted',
  'Only the child''s primary guardian can issue a link code'
);
select tests.act_as('bob');
insert into link select code from public.create_child_link_code(tests.ch('home-a'), tests.ch('m-mia'));
select tests.assert_true((select code ~ '^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$' from link),
  'The primary guardian gets a one-time code');
select tests.act_as_owner();
select tests.assert_true(
  (select c.code_hash <> convert_to((select code from link), 'UTF8')
   from private.child_link_codes c where c.child_user_id = tests.ch('mia')),
  'Only the code''s hash is stored'
);

select tests.act_as_user(tests.ch('erin'));
select tests.assert_true(
  (select outcome from public.redeem_child_link_code(tests.ch('home-b'), 'AAAA-BBBB-CCCC-DDDD',
     '#2563eb')) = 'invalid_code',
  'A guessed code links nothing'
);
select tests.assert_true(
  (select outcome from public.redeem_child_link_code(tests.ch('home-a'), (select code from link),
     '#2563eb')) = 'not_found',
  'A code cannot be redeemed in a Home the redeemer is not in'
);
select tests.assert_true(
  public.child_link_code_state(tests.ch('home-a'), tests.ch('m-mia')) is null,
  'Someone outside Home A learns nothing about its codes'
);
insert into ids select 'm-mia-b', membership_id from public.redeem_child_link_code(
  tests.ch('home-b'), lower((select code from link)), '#2563eb');
select tests.assert_true(tests.ch('m-mia-b') is not null,
  'Erin redeems the code in Home B (case and dashes do not matter)');
select tests.assert_true(
  (select my_guardian_role = 'primary' and preset = 'young_child'
   from public.home_children(tests.ch('home-b')) where membership_id = tests.ch('m-mia-b')),
  'The redeemer becomes primary guardian in Home B, on Young Child, independently of Home A'
);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.redeem_child_link_code(tests.ch('home-a'), (select code from link),
     '#2563eb')) = 'invalid_code',
  'A code works only once'
);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from auth.users where id = tests.ch('mia')) = 1
  and (select count(*) from private.home_memberships_all where user_id = tests.ch('mia')) = 2,
  'One child identity, two independent memberships'
);

delete from link;
select tests.act_as('bob');
insert into link select code from public.create_child_link_code(tests.ch('home-a'), tests.ch('m-mia'));
select tests.act_as_user(tests.ch('erin'));
select tests.assert_true(
  (select outcome from public.redeem_child_link_code(tests.ch('home-b'), (select code from link),
     '#2563eb')) = 'already_linked',
  'A child already in the Home is not linked twice'
);
delete from link;
select tests.act_as('bob');
insert into link select code from public.create_child_link_code(tests.ch('home-a'), tests.ch('m-mia'));
select tests.act_as_owner();
delete from public.child_guardians where home_id = tests.ch('home-a') and child_user_id = tests.ch('mia');
select tests.act_as_user(tests.ch('erin'));
select tests.assert_true(
  (select outcome from public.redeem_child_link_code(tests.ch('home-b'), (select code from link),
     '#2563eb')) = 'no_longer_valid',
  'A code whose issuer is no longer primary guardian is refused'
);
select tests.act_as_owner();
insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role)
  values (tests.ch('home-a'), tests.ch('mia'), tests.ch('bob'), 'primary');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.set_child_access(tests.ch('home-b'), tests.ch('m-mia-b'), 'teen',
     '{}', true, now())) = 'not_found',
  'A guardian in Home A has no authority over the child''s Home B membership'
);
select tests.assert_row_count('select 1 from public.child_home_settings', 1,
  'Bob reads the child''s Home A settings only');
select tests.act_as_user(tests.ch('erin'));
select tests.assert_true(
  public.set_child_presentation(tests.ch('home-a'), tests.ch('m-mia'), 'X', '#000000')
    = 'not_found',
  'A guardian in Home B cannot touch the child''s Home A presentation'
);
select tests.assert_row_count('select 1 from public.child_home_settings', 1,
  'Erin reads the child''s Home B settings only');
select tests.assert_row_count('select 1 from public.child_profiles', 1,
  'Erin, a guardian in Home B, reads the identity row');

select tests.act_as('bob');
select tests.assert_true(
  public.remove_home_member(tests.ch('home-a'), tests.ch('m-mia'), 'member') = 'removed',
  'The primary guardian can remove the child from a Home when they have another Home'
);
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from auth.users where id = tests.ch('mia'))
  and not exists (select 1 from public.child_guardians
                  where home_id = tests.ch('home-a') and child_user_id = tests.ch('mia')),
  'Removal from one Home keeps the identity and ends that Home''s guardianship only'
);

-- Identity lifecycle -------------------------------------------------------------------------------

delete from public.homes where id = tests.ch('home-b');
select tests.assert_true(
  not exists (select 1 from auth.users where id = tests.ch('mia')),
  'When a child''s last Home is deleted, the child identity goes with it'
);
delete from auth.users where id = tests.ch('noor');
select tests.assert_true(
  not exists (select 1 from private.home_memberships_all where user_id = tests.ch('noor')),
  'Deleting a child identity directly removes its memberships cleanly'
);
