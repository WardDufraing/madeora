-- S09: public.homes, public.home_memberships, private.audit_events and public.create_home().
-- Alice, Bob and Carol are seeded synthetic accounts. A Home is visible only to its current
-- members; each person sees only their own memberships; only a Home's Owner changes its settings;
-- nobody changes memberships through the API; every Home has exactly one Owner; every change is
-- audited out of the API's reach.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

-- Signed-out visitors -------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid())$$,
  'A signed-out visitor cannot create a Home'
);
select tests.assert_denied(
  'select id from public.homes', 'A signed-out visitor cannot read Homes'
);
select tests.assert_denied(
  'select id from public.home_memberships', 'A signed-out visitor cannot read memberships'
);

-- Creating a Home -------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_row_count(
  'select id from public.homes', 0, 'An account starts with zero Homes'
);

insert into ids values ('alice-request', '20000000-0000-4000-8000-000000000001');
insert into ids
  select 'home-a', public.create_home(
    'Thuis', 'Europe/Brussels', (select id from ids where name = 'alice-request')
  );

select tests.assert_row_count(
  $$select id from public.homes
    where id = (select id from ids where name = 'home-a')
      and name = 'Thuis' and timezone = 'Europe/Brussels'$$,
  1,
  'Alice sees the Home she created, with its name and timezone'
);
select tests.assert_row_count(
  $$select id from public.home_memberships
    where home_id = (select id from ids where name = 'home-a')
      and user_id = tests.user_id('alice') and role = 'owner'$$,
  1,
  'The creator is the Home''s Owner'
);
select tests.assert_true(
  public.create_home('Something else', 'UTC', (select id from ids where name = 'alice-request'))
    = (select id from ids where name = 'home-a'),
  'Repeating a creation request returns the same Home instead of creating a second one'
);
select tests.assert_row_count(
  'select id from public.homes', 1, 'The repeated request created nothing'
);
select tests.assert_row_count(
  $$select id from public.homes where name = 'Thuis'$$, 1, 'The repeated request changed nothing'
);
select tests.assert_denied(
  $$select public.create_home('Thuis', 'Europe/Brussels', null)$$,
  'A creation request needs a request id',
  '22023'
);
select tests.assert_denied(
  $$select public.create_home(E'\u200B', 'Europe/Brussels', gen_random_uuid())$$,
  'create_home refuses an invisible name',
  '23514'
);
select tests.assert_denied(
  $$select public.create_home('Thuis', 'not a zone!', gen_random_uuid())$$,
  'create_home refuses a malformed timezone',
  '23514'
);
select tests.assert_denied(
  $$insert into public.homes (name, timezone, creation_request_id)
    values ('Forged', 'UTC', gen_random_uuid())$$,
  'Homes cannot be inserted directly, only through create_home'
);
select tests.assert_denied(
  'select created_by, creation_request_id from public.homes',
  'Who created a Home and its request id are not readable through the API'
);

-- Bob creates Home B. The fixtures below stand in for invitations (S10): Alice joins it as a
-- Member and Carol as an Administrator.
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.assert_row_count(
  'select id from public.homes', 1, 'Bob sees only his own Home'
);

select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'member'),
  ((select id from ids where name = 'home-b'), tests.user_id('carol'), 'administrator');

-- Cross-Home reads ---------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_row_count(
  'select id from public.homes', 2, 'Alice sees both Homes she belongs to'
);
select tests.assert_row_count(
  'select id, role from public.home_memberships', 2, 'Alice sees her two memberships'
);
select tests.assert_row_count(
  $$select id from public.home_memberships where user_id <> tests.user_id('alice')$$,
  0,
  'Alice does not see other people''s memberships, not even in her own Homes'
);

select tests.act_as('bob');
select tests.assert_row_count(
  $$select id from public.homes where id = (select id from ids where name = 'home-a')$$,
  0,
  'Bob cannot read Alice''s Home, even with its id'
);
select tests.assert_row_count(
  $$select id from public.home_memberships
    where home_id = (select id from ids where name = 'home-a')$$,
  0,
  'Bob cannot read the memberships of Alice''s Home'
);

select tests.act_as('carol');
select tests.assert_row_count(
  'select id from public.homes', 1, 'Carol sees only the Home she belongs to'
);

-- Settings: only the Owner ------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_row_count(
  $$update public.homes set name = 'Ons thuis', timezone = 'Europe/Paris'
    where id = (select id from ids where name = 'home-a') returning id$$,
  1,
  'The Owner can rename her Home and change its timezone'
);
select tests.assert_row_count(
  $$update public.homes set name = 'Mine now'
    where id = (select id from ids where name = 'home-b') returning id$$,
  0,
  'A Member cannot change the settings of a Home she belongs to'
);
-- An UPDATE that reads no column skips the SELECT policy, so only the UPDATE policy limits it.
select tests.assert_row_count(
  $$update public.homes set timezone = 'UTC' returning 1$$,
  1,
  'An unfiltered update by Alice reaches only the Home she owns'
);
select tests.assert_denied(
  $$update public.homes set created_by = tests.user_id('alice')
    where id = (select id from ids where name = 'home-b')$$,
  'Nobody can change who created a Home'
);
select tests.assert_denied(
  $$update public.homes set id = gen_random_uuid()
    where id = (select id from ids where name = 'home-a')$$,
  'Nobody can change a Home''s id'
);

select tests.act_as('carol');
select tests.assert_row_count(
  $$update public.homes set name = 'Admin was here'
    where id = (select id from ids where name = 'home-b') returning id$$,
  0,
  'An Administrator without a granted capability cannot change Home settings (S12 adds grants)'
);

select tests.act_as('bob');
select tests.assert_row_count(
  $$update public.homes set name = 'Taken over'
    where id = (select id from ids where name = 'home-a') returning id$$,
  0,
  'Bob cannot change another Home''s settings with a forged id'
);

select tests.act_as_owner();
select tests.assert_true(
  (select name from public.homes where id = (select id from ids where name = 'home-b')) = 'Kot'
    and (select name from public.homes where id = (select id from ids where name = 'home-a'))
      = 'Ons thuis',
  'Refused updates changed nothing'
);

-- Memberships cannot be written through the API (forged ids, role escalation) ---------------------

select tests.act_as('bob');
select tests.assert_denied(
  $$insert into public.home_memberships (home_id, user_id, role)
    values ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'member')$$,
  'Bob cannot add himself to Alice''s Home'
);
select tests.assert_denied(
  $$insert into public.home_memberships (home_id, user_id, role)
    values ((select id from ids where name = 'home-b'), tests.user_id('carol'), 'owner')$$,
  'Even the Owner cannot add an Owner directly'
);

select tests.act_as('alice');
select tests.assert_denied(
  $$update public.home_memberships set role = 'owner'
    where home_id = (select id from ids where name = 'home-b')$$,
  'A Member cannot make herself Owner'
);
select tests.assert_denied(
  $$update public.home_memberships set home_id = (select id from ids where name = 'home-b')
    where home_id = (select id from ids where name = 'home-a')$$,
  'A membership cannot be moved to another Home'
);
select tests.assert_denied(
  $$delete from public.home_memberships
    where home_id = (select id from ids where name = 'home-a')$$,
  'The Owner cannot delete her own membership through the API'
);

select tests.act_as('carol');
select tests.assert_denied(
  $$update public.home_memberships set role = 'owner' where user_id = tests.user_id('carol')$$,
  'An Administrator cannot make herself Owner'
);
select tests.assert_denied(
  $$delete from public.home_memberships where user_id = tests.user_id('alice')$$,
  'An Administrator cannot remove a member through the API'
);

-- Exactly one Owner, at the database ------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_denied(
  $$insert into public.home_memberships (home_id, user_id, role)
    values ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'owner')$$,
  'A Home cannot get a second Owner, even from the database owner',
  '23505'
);
select tests.assert_denied(
  $$update public.home_memberships set role = 'owner'
    where home_id = (select id from ids where name = 'home-b')
      and user_id = tests.user_id('carol')$$,
  'An Administrator cannot be promoted next to the existing Owner',
  '23505'
);
-- The "at least one Owner" check runs at commit. These tests never commit, so they make it
-- immediate for the statements that should fail.
set constraints public.home_memberships_owner_required immediate;
select tests.assert_denied(
  $$update public.home_memberships set role = 'member'
    where home_id = (select id from ids where name = 'home-a')
      and user_id = tests.user_id('alice')$$,
  'The Owner cannot be demoted, leaving the Home without one',
  '23514'
);
select tests.assert_denied(
  $$delete from public.home_memberships
    where home_id = (select id from ids where name = 'home-b')
      and user_id = tests.user_id('bob')$$,
  'The Owner''s membership cannot be deleted, leaving the Home without one',
  '23514'
);
select tests.assert_denied(
  $$delete from auth.users where id = tests.user_id('bob')$$,
  'The account of a Home''s only Owner cannot be deleted until transfer-or-close exists',
  '23514'
);
set constraints public.home_memberships_owner_required deferred;

-- A Home with no Owner membership cannot be committed.
set constraints public.homes_owner_required immediate;
select tests.assert_denied(
  $$insert into public.homes (name, timezone, creation_request_id)
    values ('Ownerless', 'UTC', gen_random_uuid())$$,
  'A Home without an Owner is refused',
  '23514'
);
set constraints public.homes_owner_required deferred;

-- Revoked membership ----------------------------------------------------------------------------------

-- Removing Carol (here as the database owner; the removal flow is S12) takes her access at once.
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('carol');

select tests.act_as('carol');
select tests.assert_row_count(
  'select id from public.homes', 0, 'A removed member no longer sees the Home'
);
select tests.assert_row_count(
  'select id from public.home_memberships', 0, 'A removed member has no membership left'
);
select tests.assert_row_count(
  $$update public.homes set name = 'Still here?'
    where id = (select id from ids where name = 'home-b') returning id$$,
  0,
  'A removed member cannot change the Home'
);

-- An ordinary member's account can be deleted; their membership goes with it.
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
set constraints public.home_memberships_owner_required immediate;
delete from auth.users where id = tests.user_id('carol');
set constraints public.home_memberships_owner_required deferred;
select tests.assert_true(
  not exists (
    select 1 from public.home_memberships where user_id = '10000000-0000-4000-8000-000000000003'
  ),
  'Deleting a Member''s account removes their memberships'
);

-- Accounts that may not create Homes ------------------------------------------------------------------

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
  values (
    '00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-0000000000aa',
    'authenticated', 'authenticated', 'unconfirmed@madeora.test', '', now(), now()
  );
select tests.act_as_user('10000000-0000-4000-8000-0000000000aa');
select tests.assert_denied(
  $$select public.create_home('Thuis', 'UTC', gen_random_uuid())$$,
  'An account with an unconfirmed email cannot create a Home'
);
select tests.act_as_user('10000000-0000-4000-8000-0000000000ff');
select tests.assert_denied(
  $$select public.create_home('Thuis', 'UTC', gen_random_uuid())$$,
  'A token for an account that does not exist cannot create a Home'
);

-- Name policy and timezone at the database ------------------------------------------------------------
-- The app applies the same rules first (apps/web/src/names/visible-name.ts); these prove a direct
-- Data API write cannot get around them.

select tests.act_as_owner();
create temporary table bad_names (value text, why text) on commit drop;
grant all on bad_names to authenticated;
insert into bad_names values
  ('', 'an empty name'),
  (repeat('a', 51), 'a name over 50 characters'),
  (' Thuis', 'a leading space'),
  (E'Thuis\u00A0', 'a trailing no-break space'),
  (E'\u3000Thuis', 'a leading ideographic space'),
  (E'Thu\u200Bis', 'a zero-width space inside'),
  (E'\u200B', 'only a zero-width space'),
  (E'Thuis\u2060', 'a word joiner'),
  (E'\uFEFFThuis', 'a byte order mark'),
  (E'Thu\u00ADis', 'a soft hyphen'),
  (E'Thuis\u202E', 'a right-to-left override'),
  (E'\u2067Thuis\u2069', 'direction isolates'),
  (E'Thuis\u200E', 'a left-to-right mark'),
  (E'\u3164', 'only a Hangul filler'),
  (E'\u2800', 'only a Braille blank'),
  (E'A\u2028B', 'a line separator'),
  (E'A\u0007B', 'a control character'),
  (E'\u0301', 'only a combining mark'),
  (E'\u200DThuis', 'a leading zero-width joiner'),
  (E'Thuis\u200D', 'a trailing zero-width joiner'),
  (E'A \u200DB', 'a joiner after a space'),
  (E'A\u200D\u200DB', 'two joiners in a row'),
  (E'\uFE0FThuis', 'a leading variation selector'),
  (E'A \uFE0F', 'a variation selector after a space'),
  (E'Thuis\U000E0041', 'a stray tag character'),
  (E'\u00A0\u200C', 'only invisible characters'),
  (E'e\u0301', 'a name that is not NFC-normalized');

select tests.assert_true(
  (select count(*) from bad_names) = 27, 'All bad names are listed'
);

select tests.act_as('alice');
do $$
declare
  r record;
begin
  for r in select value, why from bad_names loop
    perform tests.assert_denied(
      format(
        $q$update public.homes set name = %L
           where id = (select id from ids where name = 'home-a')$q$,
        r.value
      ),
      'The database refuses ' || r.why,
      '23514'
    );
  end loop;
end
$$;

select tests.act_as_owner();
create temporary table good_names (value text) on commit drop;
grant all on good_names to authenticated;
insert into good_names values
  ('Thuis'),
  (E'Famille Dupr\u00E9'),
  (repeat('a', 50)),
  (E'\u5BB6'),
  (E'\u062E\u0627\u0646\u0647'),
  (E'\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'),
  (E'\U0001F468\u200D\U0001F469\u200D\U0001F467'),
  (E'Thuis \u2764\uFE0F'),
  (E'\U0001F441\uFE0F\u200D\U0001F5E8\uFE0F'),
  (E'\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F Home'),
  (E'De\u00A0Bron'),
  (E'\U0001F3E0');

select tests.act_as('alice');
do $$
declare
  r record;
begin
  for r in select value from good_names loop
    perform tests.assert_allowed(
      format(
        $q$update public.homes set name = %L
           where id = (select id from ids where name = 'home-a')$q$,
        r.value
      ),
      format('The database accepts the name %L', r.value)
    );
  end loop;
end
$$;

select tests.assert_denied(
  $$update public.homes set timezone = 'Europe/../etc/passwd'
    where id = (select id from ids where name = 'home-a')$$,
  'The database refuses a malformed timezone',
  '23514'
);
select tests.assert_denied(
  $$update public.homes set timezone = repeat('A', 65)
    where id = (select id from ids where name = 'home-a')$$,
  'The database refuses an over-long timezone',
  '23514'
);

-- Audit -----------------------------------------------------------------------------------------------

select tests.assert_denied(
  'select * from private.audit_events', 'The audit log is not readable through the API'
);
select tests.assert_denied(
  $$insert into private.audit_events (action, subject_type) values ('home.forged', 'home')$$,
  'The audit log is not writable through the API'
);

select tests.act_as_owner();
select tests.assert_true(
  exists (
    select 1 from private.audit_events
    where action = 'home.created' and actor_user_id = tests.user_id('alice')
      and home_id = (select id from ids where name = 'home-a')
  ),
  'Creating a Home is audited with the creator as actor'
);
select tests.assert_true(
  exists (
    select 1 from private.audit_events
    where action = 'home_membership.created' and actor_user_id = tests.user_id('alice')
      and home_id = (select id from ids where name = 'home-a')
      and subject_id = tests.user_id('alice') and details = '{"role": "owner"}'
  ),
  'The Owner membership is audited'
);
select tests.assert_true(
  exists (
    select 1 from private.audit_events
    where action = 'home.settings_changed' and actor_user_id = tests.user_id('alice')
      and home_id = (select id from ids where name = 'home-a')
      and details = '{"fields": ["name", "timezone"]}'
  ),
  'A settings change is audited with the changed fields only, never their values'
);
select tests.assert_true(
  not exists (
    select 1 from private.audit_events where details::text like '%Ons thuis%'
  ),
  'The audit log does not store the names people typed'
);
select tests.assert_true(
  exists (
    select 1 from private.audit_events
    where action = 'home_membership.ended' and actor_user_id is null
      and subject_id = '10000000-0000-4000-8000-000000000003'
      and home_id = (select id from ids where name = 'home-b')
      and details = '{"role": "administrator"}'
  ),
  'A removed membership is audited (here without a signed-in actor)'
);
select tests.assert_true(
  (
    select count(*) from private.audit_events
    where home_id = (select id from ids where name = 'home-b')
      and action = 'home.settings_changed'
  ) = 0,
  'Refused updates leave no audit record'
);
