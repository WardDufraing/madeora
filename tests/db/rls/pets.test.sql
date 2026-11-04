-- S31: pets (supabase/migrations/*_pets.sql). Alice owns Home A, where Bob is an Administrator and Carol
-- a Member; Bob owns Home B, which Carol is not in.
-- Covers: nothing reachable as a table; who may create and edit pets (manageHomePets); a name-only pet;
-- partial profiles, Unknown vs not entered vs None, malformed values refused without saving anything;
-- medical access as its own permission (none, view, manage; Owner implicit; granting rules, never
-- one's own; effective at once; ends with the membership); sensitive details, medical entries and
-- attachments hidden from members without medical view, including file reads, counts, trash entries
-- and errors; entry dates and follow-ups; stale revisions; photo uploads; delete and restore of pets,
-- entries and attachments with their files; isolation between Homes and forged ids; audit without
-- content.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
insert into ids select 'm-alice-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');

insert into ids select n, gen_random_uuid() from unnest(array[
  'p-rex', 'p-mia', 'p-b', 'p-bad', 'p-gone', 'e-vacc', 'e-visit', 'e-b', 'e-bad', 'e-gone'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.d(p_days integer) returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date + p_days; $$;
create function tests.rev(p_name text) returns integer
  language sql security definer as $$ select revision from private.pets where id = tests.i(p_name); $$;
create function tests.erev(p_name text) returns integer
  language sql security definer as $$ select revision from private.pet_medical_entries where id = tests.i(p_name); $$;
create function tests.mrev(p_name text) returns integer
  language sql security definer as $$
  select coalesce((select revision from private.pet_medical_details where pet_id = tests.i(p_name)), 0); $$;
create function tests.create(p_name text, p_home text, p_label text) returns text
  language sql as $$ select public.create_pet(tests.i(p_name), tests.i(p_home), p_label) ->> 'outcome'; $$;
create function tests.upd(p_name text, p_profile jsonb) returns text
  language sql as $$ select public.update_pet(tests.i(p_name), tests.rev(p_name), p_profile) ->> 'outcome'; $$;
create function tests.pet(p_name text) returns jsonb
  language plpgsql as $$ begin return public.get_pet(tests.i(p_name)); end $$;
create function tests.medical(p_name text) returns jsonb
  language plpgsql as $$ begin return public.get_pet_medical(tests.i(p_name)); end $$;
create function tests.entry(p_id text, p_pet text, p_body jsonb) returns text
  language sql as $$ select public.create_pet_medical_entry(tests.i(p_id), tests.i(p_pet), p_body) ->> 'outcome'; $$;
create function tests.grant_level(p_member text, p_level text) returns text
  language sql as $$ select public.set_pet_medical_access(tests.i('home-a'), tests.i(p_member), p_level); $$;
create function tests.file_status(p_name text) returns text
  language sql stable security definer as $$ select status from private.stored_files where id = tests.i(p_name); $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
create function tests.attachment_of(p_file text) returns uuid
  language sql stable security definer as $$
  select id from private.pet_medical_attachments where file_id = tests.i(p_file); $$;
create function tests.open_trash(p_item_type text) returns uuid
  language sql stable security definer as $$
  select id from private.trash_entries where item_type = p_item_type and status = 'trashed' limit 1; $$;
create function tests.trash_of(p_home text, p_item_type text) returns bigint
  language plpgsql as $$
  begin return (select count(*) from public.list_trash(tests.i(p_home), 'pets', p_item_type)); end $$;
-- Opens an upload as the current actor and finalizes it as the server would; records the file.
create function tests.upload(p_user text, p_name text, p_kind text, p_target text, p_type text default 'application/pdf')
returns text
  language plpgsql as $$
  declare
    v record;
    v_outcome text;
  begin
    perform tests.act_as(p_user);
    if p_kind = 'photo' then
      select * into v from public.create_pet_photo_intent(tests.i(p_target), 'image/jpeg', 2000, gen_random_uuid());
    else
      select * into v from public.create_pet_medical_attachment_intent(tests.i(p_target), p_type, 2000,
        p_name || '.pdf', gen_random_uuid());
    end if;
    if v.outcome <> 'ok' then
      return v.outcome;
    end if;
    insert into ids values (p_name, v.file_id);
    perform tests.act_as_service_role();
    v_outcome := public.finalize_upload(tests.user_id(p_user), v.file_id,
      case when p_kind = 'photo' then 'image/webp' else p_type end, 1500,
      encode(extensions.digest(p_name, 'sha256'), 'hex'));
    perform tests.act_as(p_user);
    if v_outcome <> 'ready' then
      return v_outcome;
    end if;
    if p_kind = 'photo' then
      return public.set_pet_photo(v.file_id) ->> 'outcome';
    end if;
    return public.attach_pet_medical_file(v.file_id) ->> 'outcome';
  end
  $$;
grant execute on function tests.i(text), tests.d(integer), tests.rev(text), tests.erev(text), tests.mrev(text),
  tests.create(text, text, text), tests.upd(text, jsonb), tests.pet(text), tests.medical(text),
  tests.entry(text, text, jsonb), tests.grant_level(text, text), tests.file_status(text),
  tests.private_count(text), tests.trash_of(text, text), tests.attachment_of(text), tests.open_trash(text), tests.upload(text, text, text, text, text)
  to authenticated, service_role;

-- Nothing is reachable as a table ---------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.pets', 'The API cannot read pets');
select tests.assert_denied('select * from private.pet_medical_details', 'Nor sensitive details');
select tests.assert_denied('select * from private.pet_medical_entries', 'Nor medical entries');
select tests.assert_denied('select * from private.pet_medical_attachments', 'Nor attachments');
select tests.assert_denied('select * from private.pet_medical_access', 'Nor medical grants');
select tests.assert_denied($$select private.pet_medical_level(tests.i('home-a'), tests.user_id('alice'))$$,
  'Nor the helpers');
select tests.assert_denied($$select private.can_see_trash_entry_before_pets(null, null)$$, 'Nor the renamed rule');
select tests.assert_denied($$select public.expire_upload(gen_random_uuid())$$, 'Upload expiry is the service role''s');
select tests.act_as_anon();
select tests.assert_denied($$select public.list_pets(gen_random_uuid())$$, 'Nobody signed out reads pets');

-- Creating, and who may -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((public.list_pets(tests.i('home-a')) ->> 'access') = 'view'
  and (public.list_pets(tests.i('home-a')) -> 'medicalAccess') = 'null'::jsonb,
  'A member sees pets, with no medical access');
select tests.assert_true(tests.create('p-bad', 'home-a', 'Bad') = 'not_permitted', 'A member does not add pets');
select tests.assert_denied($$select public.list_pets(tests.i('home-b'))$$, 'Not in a Home she is not in');
select tests.assert_denied($$select tests.create('p-bad', 'home-b', 'Bad')$$, 'Nor adds there (42501)');
select tests.act_as('bob');
select tests.assert_true(tests.create('p-bad', 'home-a', 'Bad') = 'not_permitted',
  'An Administrator without manageHomePets does not add pets');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomePets']);
select tests.act_as('bob');
select tests.assert_true((public.list_pets(tests.i('home-a')) ->> 'access') = 'manage'
  and (public.list_pets(tests.i('home-a')) -> 'medicalAccess') = 'null'::jsonb,
  'Granted manageHomePets, Bob manages pets but still has no medical access');
select tests.assert_true(tests.create('p-rex', 'home-a', 'Rex') = 'created', 'He adds a pet with only its name');
select tests.assert_true(tests.create('p-rex', 'home-a', 'Rex') = 'exists', 'A retry answers exists');
select tests.assert_true(tests.create('p-b', 'home-b', 'Pluis') = 'created', 'Bob adds a pet in his own Home');
select tests.act_as('alice');
select tests.assert_true(tests.create('p-rex', 'home-a', 'Rex') = 'id_taken', 'Someone else reusing the id is refused');
select tests.assert_denied($$select tests.create('p-bad', 'home-a', '   ')$$, 'A blank name is refused', '22023');
select tests.assert_denied($$select tests.create('p-bad', 'home-a', repeat('x', 81))$$, 'And a long one', '22023');
select tests.assert_true(tests.create('p-mia', 'home-a', 'Mia') = 'created', 'The Owner adds a pet');
select tests.assert_true(
  (select jsonb_array_length(public.list_pets(tests.i('home-a')) -> 'pets') = 2), 'Home A lists two pets');
select tests.assert_true(tests.pet('p-b') is null, 'Not Home B''s pet');
select tests.act_as('carol');
select tests.assert_true((tests.pet('p-rex') ->> 'name') = 'Rex' and (tests.pet('p-rex') ->> 'access') = 'view',
  'Carol sees Rex');
select tests.assert_true(tests.pet('p-b') is null, 'A forged id from another Home reads as nothing');

-- The profile: partial, Unknown vs not entered, validation --------------------------------------------

select tests.act_as('bob');
select tests.assert_true(tests.upd('p-rex', jsonb_build_object('name', 'Rex', 'species', 'dog', 'breed', 'Labrador',
  'ageYears', 3, 'ageMonths', 6, 'weight', 28.4, 'weightUnit', 'kg', 'vetName', 'Dr. Peeters',
  'vetPhone', '+32 9 123 45 67', 'vetEmail', 'praktijk@example.test', 'diet', 'Twee keer per dag brokken',
  'unknown', jsonb_build_array('sex'))) = 'saved', 'A partly filled profile saves');
select tests.assert_true((tests.pet('p-rex') ->> 'breed') = 'Labrador' and (tests.pet('p-rex') ->> 'ageYears') = '3'
  and (tests.pet('p-rex') ->> 'ageRecordedOn')::date = tests.d(0) and (tests.pet('p-rex') -> 'birthDate') = 'null'::jsonb
  and (tests.pet('p-rex') ->> 'weight')::numeric = 28.4 and (tests.pet('p-rex') -> 'unknown') = '["sex"]'::jsonb
  and (tests.pet('p-rex') -> 'neutered') = 'null'::jsonb,
  'And reads back: an approximate age never becomes a birthday; sex Unknown, neutered not entered');
select tests.assert_true(tests.upd('p-rex', (tests.pet('p-rex') - 'breed') || '{"unknown": ["sex", "breed"]}') = 'saved',
  'An optional field is removed and marked Unknown');
select tests.assert_true((tests.pet('p-rex') -> 'breed') = 'null'::jsonb
  and (tests.pet('p-rex') -> 'unknown') = '["breed", "sex"]'::jsonb, 'Removed and Unknown');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "birthDate": "2099-01-01"}')$$,
  'A future birth date is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "birthDate": "2024-02-30"}')$$,
  'An impossible date is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "birthDate": "2020-01-01", "ageYears": 2}')$$,
  'A birth date and an approximate age together are refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "weight": 0, "weightUnit": "kg"}')$$,
  'A zero weight is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "weight": 4.1234, "weightUnit": "kg"}')$$,
  'More than three decimals are refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "weight": 4}')$$,
  'A weight without a unit is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "vetEmail": "not-an-email"}')$$,
  'A malformed email is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "vetPhone": "call me"}')$$,
  'A malformed phone number is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "species": "dragon"}')$$,
  'An unknown species is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "speciesLabel": "Draak"}')$$,
  'A species label without species other is refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "breed": "Lab", "unknown": ["breed"]}')$$,
  'A value and Unknown together are refused', '22023');
select tests.assert_denied($$select tests.upd('p-rex', '{"name": "Rex", "unknown": ["allergies"]}')$$,
  'A sensitive field cannot be marked on the basic profile', '22023');
select tests.assert_true((tests.pet('p-rex') ->> 'weight')::numeric = 28.4 and (tests.pet('p-rex') ->> 'vetName') = 'Dr. Peeters',
  'Nothing of a refused request was saved');
select tests.assert_true(
  (select public.update_pet(tests.i('p-rex'), tests.rev('p-rex') - 1, '{"name": "Old"}') ->> 'outcome') = 'stale',
  'An edit from an old revision is stale');
select tests.act_as('carol');
select tests.assert_true(tests.upd('p-rex', '{"name": "Mine"}') = 'not_permitted', 'A member does not edit pets');
select tests.act_as('bob');
select tests.assert_true(tests.upd('p-mia', '{"name": "Mia", "species": "other", "speciesLabel": "Fret",
  "birthDate": "2022-05-01", "sex": "female", "neutered": true}') = 'saved', 'Another species with its label');
select tests.assert_true(tests.private_count($$select count(*) from private.audit_events where action = 'pet.updated'
  and details::text like '%Peeters%'$$) = 0, 'The audit names fields, never values');

-- Medical access -------------------------------------------------------------------------------------

select tests.assert_true(tests.medical('p-rex') is null, 'A pet manager without medical access reads nothing medical');
select tests.assert_true(
  (select public.set_pet_medical_details(tests.i('p-rex'), 0, '{"allergies": "Kip"}') ->> 'outcome') = 'not_found',
  'And cannot write it (the same answer as a missing pet)');
select tests.assert_true(tests.entry('e-bad', 'p-rex', jsonb_build_object('type', 'vet_visit', 'date', tests.d(0))) = 'not_found',
  'Nor add an entry');
select tests.assert_true(tests.grant_level('m-carol-a', 'view') = 'not_permitted',
  'An Administrator without managePetMedicalAccess cannot grant');
select tests.act_as('carol');
select tests.assert_true(tests.grant_level('m-carol-a', 'manage') = 'not_permitted', 'A member cannot grant herself');
select tests.assert_true((public.list_pet_medical_access(tests.i('home-a')) ->> 'canGrant')::boolean = false
  and jsonb_array_length(public.list_pet_medical_access(tests.i('home-a')) -> 'members') = 1,
  'And sees only her own level');
select tests.act_as('alice');
select tests.assert_true((tests.medical('p-rex') ->> 'level') = 'manage', 'The Owner has medical access without a grant');
select tests.assert_true(tests.grant_level('m-alice-a', 'none') = 'not_permitted', 'Nobody changes the Owner''s');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'),
  array['manageHomePets', 'managePetMedicalAccess']);
select tests.act_as('bob');
select tests.assert_true(tests.grant_level('m-bob-a', 'manage') = 'not_permitted',
  'Granted managePetMedicalAccess, Bob still cannot grant himself');
select tests.assert_true(tests.medical('p-rex') is null, 'And the capability alone gives him no medical access');
select tests.assert_true(tests.grant_level('m-carol-a', 'view') = 'ok', 'He grants Carol view');
select tests.assert_true(tests.grant_level('m-carol-a', 'view') = 'unchanged', 'Again: unchanged');
select tests.assert_true(jsonb_array_length(public.list_pet_medical_access(tests.i('home-a')) -> 'members') = 3,
  'A grantor sees every member');
select tests.act_as('alice');
select tests.assert_true(tests.grant_level('m-bob-a', 'manage') = 'ok', 'The Owner grants Bob manage');
select tests.assert_true(tests.private_count($$select count(*) from private.audit_events
  where action = 'pet.medical_access.changed'$$) = 2, 'Each change is audited');

-- Sensitive details ----------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true((public.set_pet_medical_details(tests.i('p-rex'), 0, '{"allergies": null, "medications": "Apoquel 16 mg",
  "microchip": "981000000000001", "none": ["allergies"], "unknown": ["registration"]}') ->> 'outcome') = 'saved',
  'A medical manager records details: allergies None, registration Unknown');
select tests.assert_true((tests.medical('p-rex') -> 'details' ->> 'medications') = 'Apoquel 16 mg'
  and (tests.medical('p-rex') -> 'details' -> 'none') = '["allergies"]'::jsonb
  and (tests.medical('p-rex') -> 'details' -> 'unknown') = '["registration"]'::jsonb
  and (tests.medical('p-rex') -> 'details' -> 'allergies') = 'null'::jsonb, 'None and Unknown read back distinctly');
select tests.assert_denied($$select public.set_pet_medical_details(tests.i('p-rex'), tests.mrev('p-rex'),
  '{"allergies": "Kip", "none": ["allergies"]}')$$, 'A value and None together are refused', '22023');
select tests.assert_denied($$select public.set_pet_medical_details(tests.i('p-rex'), tests.mrev('p-rex'),
  '{"none": ["microchip"]}')$$, 'None only for allergies and medications', '22023');
select tests.assert_true((public.set_pet_medical_details(tests.i('p-rex'), 0, '{}') ->> 'outcome') = 'stale',
  'An old revision is stale');
select tests.act_as('carol');
select tests.assert_true((tests.medical('p-rex') -> 'details' ->> 'medications') = 'Apoquel 16 mg'
  and (tests.medical('p-rex') ->> 'level') = 'view', 'A medical viewer reads them');
select tests.assert_true((public.set_pet_medical_details(tests.i('p-rex'), tests.mrev('p-rex'), '{}') ->> 'outcome') = 'not_permitted',
  'But does not edit them');
select tests.assert_true(position('Apoquel' in tests.pet('p-rex')::text) = 0
  and position('981000000000001' in public.list_pets(tests.i('home-a'))::text) = 0,
  'The basic profile and the list never carry a sensitive value');

-- Medical entries -----------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(tests.entry('e-vacc', 'p-rex', jsonb_build_object('type', 'vaccination', 'date', tests.d(-30))) = 'created',
  'A vaccination with only its type and date');
select tests.assert_true(tests.entry('e-vacc', 'p-rex', jsonb_build_object('type', 'vaccination', 'date', tests.d(-30))) = 'exists',
  'A retry answers exists');
select tests.assert_true(tests.entry('e-visit', 'p-rex', jsonb_build_object('type', 'vet_visit', 'date', tests.d(14),
  'title', 'Jaarlijkse controle', 'veterinarian', 'Dr. Peeters', 'location', 'Gent', 'notes', 'Nuchter komen')) = 'created',
  'A future vet visit (an upcoming appointment)');
select tests.assert_true(tests.entry('e-b', 'p-b', jsonb_build_object('type', 'vet_visit', 'date', tests.d(0))) = 'created',
  'Bob, Home B''s Owner, adds one there');
select tests.assert_denied($$select tests.entry('e-bad', 'p-rex', jsonb_build_object('type', 'vet_visit', 'date', tests.d(800)))$$,
  'More than two years ahead is refused', '22023');
select tests.assert_denied($$select tests.entry('e-bad', 'p-rex', '{"type": "vet_visit", "date": "1970-01-01"}')$$,
  'Before 1980 is refused', '22023');
select tests.assert_denied($$select tests.entry('e-bad', 'p-mia', '{"type": "vet_visit", "date": "2021-01-01"}')$$,
  'Before the pet''s known birth date is refused', '22023');
select tests.assert_denied($$select tests.entry('e-bad', 'p-rex', jsonb_build_object('type', 'vet_visit', 'date', tests.d(0),
  'followUpDate', tests.d(-1)))$$, 'A follow-up before the event is refused', '22023');
select tests.assert_denied($$select tests.entry('e-bad', 'p-rex', jsonb_build_object('type', 'checkup', 'date', tests.d(0)))$$,
  'An unknown type is refused', '22023');
select tests.assert_denied($$select tests.entry('e-bad', 'p-rex', '{"type": "vet_visit"}')$$,
  'A date is required', '22023');
select tests.assert_true(
  (select jsonb_agg(e ->> 'type') from jsonb_array_elements(tests.medical('p-rex') -> 'entries') e) = '["vet_visit", "vaccination"]'::jsonb,
  'Entries newest first');
select tests.assert_true((select public.update_pet_medical_entry(tests.i('e-vacc'), tests.erev('e-vacc'),
  jsonb_build_object('type', 'vaccination', 'date', tests.d(-31), 'title', 'Rabiës')) ->> 'outcome') = 'saved',
  'A correction in place');
select tests.assert_true((public.get_pet_medical_entry(tests.i('e-vacc')) ->> 'title') = 'Rabiës'
  and (public.get_pet_medical_entry(tests.i('e-vacc')) ->> 'date')::date = tests.d(-31), 'Corrected');
select tests.assert_true((select public.update_pet_medical_entry(tests.i('e-vacc'), 1,
  jsonb_build_object('type', 'vaccination', 'date', tests.d(-31))) ->> 'outcome') = 'stale', 'Stale');
select tests.assert_true(public.get_pet_medical_entry(tests.i('e-b')) is not null, 'Bob reads Home B''s entry');
select tests.act_as('carol');
select tests.assert_true(public.get_pet_medical_entry(tests.i('e-vacc')) is not null, 'The viewer reads an entry');
select tests.assert_true((select public.update_pet_medical_entry(tests.i('e-vacc'), tests.erev('e-vacc'),
  jsonb_build_object('type', 'vaccination', 'date', tests.d(-31))) ->> 'outcome') = 'not_permitted', 'But does not correct it');
select tests.assert_true(tests.entry('e-bad', 'p-rex', jsonb_build_object('type', 'vet_visit', 'date', tests.d(0))) = 'not_permitted',
  'Nor adds one');
select tests.assert_true(public.get_pet_medical_entry(tests.i('e-b')) is null
  and (select public.update_pet_medical_entry(tests.i('e-b'), 1, '{}') ->> 'outcome') = 'not_found',
  'Another Home''s entry is not found, whatever she tries');
select tests.act_as('alice');
select tests.assert_true(public.get_pet_medical_entry(tests.i('e-b')) is null
  and tests.entry('e-bad', 'p-b', jsonb_build_object('type', 'vet_visit', 'date', tests.d(0))) = 'not_found',
  'Alice, Owner of Home A only, reaches nothing medical in Home B');

-- Attachments and file reads -------------------------------------------------------------------------

select tests.assert_true(tests.upload('bob', 'f-cert', 'attachment', 'e-vacc') = 'attached', 'Bob attaches a certificate');
select tests.assert_true(tests.upload('bob', 'f-scan', 'attachment', 'e-vacc', 'image/png') = 'attached', 'And a scan');
select tests.assert_true(
  (select jsonb_array_length(public.get_pet_medical_entry(tests.i('e-vacc')) -> 'attachments') = 2), 'Two attachments');
select tests.assert_denied($$select * from public.create_pet_medical_attachment_intent(tests.i('e-vacc'), 'text/html', 100,
  'x.html', gen_random_uuid())$$, 'An unsupported type is refused', '22023');
select tests.assert_denied($$select * from public.create_pet_medical_attachment_intent(tests.i('e-vacc'), 'application/pdf',
  10485761, 'x.pdf', gen_random_uuid())$$, 'An oversized file is refused', '22023');
select tests.act_as('carol');
select tests.assert_true(tests.upload('carol', 'f-bad', 'attachment', 'e-vacc') = 'not_permitted', 'A viewer does not attach');
select tests.assert_true((select count(*) = 1 from public.authorize_file_read(tests.i('f-cert'))), 'The viewer opens the certificate');
select tests.act_as('bob');
select tests.assert_true(tests.grant_level('m-carol-a', 'none') = 'ok', 'Bob revokes Carol''s medical access');
select tests.act_as('carol');
select tests.assert_true((select count(*) = 0 from public.authorize_file_read(tests.i('f-cert'))),
  'At once she can no longer open it');
select tests.assert_true(tests.medical('p-rex') is null and public.get_pet_medical_entry(tests.i('e-vacc')) is null,
  'Nor read details or entries');
select tests.assert_true((tests.pet('p-rex') ->> 'name') = 'Rex', 'She still sees the basic profile');
select tests.assert_true((select public.update_pet_medical_entry(tests.i('e-vacc'), tests.erev('e-vacc'), '{}') ->> 'outcome') = 'not_found'
  and (select public.update_pet_medical_entry(gen_random_uuid(), 1, '{}') ->> 'outcome') = 'not_found',
  'A known entry id answers not_found, exactly like a missing one');

-- A photo, visible to every member
select tests.assert_true(tests.upload('bob', 'f-photo', 'photo', 'p-rex') = 'saved', 'Bob adds Rex''s photo');
select tests.act_as('carol');
select tests.assert_true((tests.pet('p-rex') ->> 'photoFileId')::uuid = tests.i('f-photo')
  and (select count(*) = 1 from public.authorize_file_read(tests.i('f-photo'))), 'Every member sees the photo');
select tests.assert_true(tests.upload('carol', 'f-bad2', 'photo', 'p-rex') = 'not_permitted', 'A member does not change it');
select tests.assert_true(tests.upload('bob', 'f-photo2', 'photo', 'p-rex') = 'saved', 'Bob replaces it');
select tests.assert_true(tests.file_status('f-photo') = 'deleted' and tests.file_status('f-photo2') = 'ready',
  'The old photo is retired');
select tests.act_as('bob');
select tests.assert_true((select count(*) = 0 from public.authorize_file_read(tests.i('f-photo'))), 'And no longer readable');

-- Trash: entries and attachments ----------------------------------------------------------------------

select tests.assert_true((public.remove_pet_medical_attachment(
  tests.attachment_of('f-scan')) ->> 'outcome') = 'removed',
  'Bob removes the scan');
select tests.assert_true(tests.file_status('f-scan') = 'deleted', 'Its file goes to the file trash');
select tests.assert_true((public.delete_pet_medical_entry(tests.i('e-visit'), tests.erev('e-visit')) ->> 'outcome') = 'deleted',
  'He deletes the upcoming visit');
select tests.assert_true(tests.trash_of('home-a', 'pet_medical_entry') = 1 and tests.trash_of('home-a', 'pet_medical_attachment') = 1,
  'A medical manager sees both in the trash');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'),
  array['manageHomePets', 'managePetMedicalAccess', 'manageHomeSettings']);
select tests.assert_true(tests.grant_level('m-bob-a', 'view') = 'ok', 'Bob is lowered to medical view');
select tests.act_as('bob');
select tests.assert_true(tests.trash_of('home-a', 'pet_medical_entry') = 0
  and (select count(*) from public.list_trash(tests.i('home-a'))) = 0,
  'Without medical manage the entries vanish from his trash, even with manageHomeSettings and as their deleter');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.open_trash('pet_medical_entry')])) = 'not_found', 'He cannot restore them');
select tests.act_as('carol');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'))) = 0, 'Carol sees none of it');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[(select entry_id from public.list_trash(tests.i('home-a'), 'pets', 'pet_medical_attachment'))])) = 'restored',
  'The Owner restores the scan');
select tests.assert_true(tests.file_status('f-scan') = 'ready', 'With its file');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[(select entry_id from public.list_trash(tests.i('home-a'), 'pets', 'pet_medical_entry'))])) = 'restored',
  'And the visit');
select tests.assert_true(public.get_pet_medical_entry(tests.i('e-visit')) is not null, 'Which is back');

-- Trash: pets ---------------------------------------------------------------------------------------

select tests.assert_true(tests.grant_level('m-bob-a', 'manage') = 'ok', 'Bob manages medical information again');
select tests.act_as('carol');
select tests.assert_true((public.delete_pet(tests.i('p-rex'), tests.rev('p-rex')) ->> 'outcome') = 'not_permitted',
  'A member does not delete a pet');
select tests.act_as('bob');
select tests.assert_true((public.delete_pet(tests.i('p-rex'), tests.rev('p-rex')) ->> 'outcome') = 'deleted',
  'Bob deletes Rex');
select tests.assert_true(tests.pet('p-rex') is null and tests.medical('p-rex') is null
  and public.get_pet_medical_entry(tests.i('e-vacc')) is null, 'Rex and his medical history are gone');
select tests.assert_true(tests.file_status('f-photo2') = 'deleted' and tests.file_status('f-cert') = 'deleted',
  'The photo and attachments go to the file trash with him');
select tests.assert_true((select count(*) = 0 from public.authorize_file_read(tests.i('f-cert'))), 'Unreadable');
select tests.assert_true(tests.trash_of('home-a', 'pet') = 1, 'A pet manager sees the pet in the trash');
select tests.act_as('alice');
select tests.assert_true(tests.grant_level('m-bob-a', 'none') = 'ok', 'Bob loses medical access for a moment');
select tests.act_as('bob');
select tests.assert_true(tests.trash_of('home-a', 'pet') = 0,
  'Without medical manage a pet manager does not see the pet in the trash (for every pet)');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.open_trash('pet')])) = 'not_found'
  and (select outcome from public.purge_trash_entries(array[tests.open_trash('pet')])) = 'not_found',
  'Nor restores or purges it');
select tests.assert_true(tests.private_count(format(
  'select count(*) from private.trash_entry_files ef join private.trash_entries t on t.id = ef.entry_id
   where t.subject_id = %L and ef.file_id = %L', tests.i('p-rex'), tests.i('f-cert'))) = 0
  and tests.private_count(format('select count(*) from private.pet_trash_files where file_id = %L',
    tests.i('f-cert'))) = 1,
  'The document is held apart from the shared trash file list');
select tests.act_as('alice');
select tests.assert_true(tests.grant_level('m-bob-a', 'manage') = 'ok', 'Bob manages medical information again');
select tests.act_as('bob');
select tests.assert_true(
  (select file_count from public.list_trash(tests.i('home-a'), 'pets', 'pet')) = 1,
  'The pet''s trash entry counts only its photo, never its medical documents');
select tests.act_as('carol');
select tests.assert_true(tests.trash_of('home-a', 'pet') = 0, 'A member does not');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[(select entry_id from public.list_trash(tests.i('home-a'), 'pets', 'pet'))])) = 'restored',
  'He restores Rex');
select tests.assert_true((tests.pet('p-rex') ->> 'photoFileId')::uuid = tests.i('f-photo2')
  and (tests.medical('p-rex') -> 'details' ->> 'medications') = 'Apoquel 16 mg'
  and jsonb_array_length(tests.medical('p-rex') -> 'entries') = 2
  and tests.file_status('f-cert') = 'ready', 'Back with photo, details, entries and files');
select tests.act_as('carol');
select tests.assert_true(tests.medical('p-rex') is null and (select count(*) = 0 from public.authorize_file_read(tests.i('f-cert'))),
  'Restored sensitive records keep their protection');

-- Purging a pet settles its medical trash entries
select tests.act_as('bob');
select tests.assert_true(tests.create('p-gone', 'home-a', 'Weg') = 'created', 'A pet to purge');
select tests.assert_true(tests.entry('e-gone', 'p-gone', jsonb_build_object('type', 'surgery', 'date', tests.d(-1))) = 'created',
  'With an entry');
select tests.assert_true((public.delete_pet_medical_entry(tests.i('e-gone'), tests.erev('e-gone')) ->> 'outcome') = 'deleted',
  'The entry is deleted first');
select tests.assert_true((public.delete_pet(tests.i('p-gone'), tests.rev('p-gone')) ->> 'outcome') = 'deleted', 'Then the pet');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[(select entry_id from public.list_trash(tests.i('home-a'), 'pets', 'pet_medical_entry'))]))
    = 'needs_resolution', 'The entry cannot come back while its pet is in the trash');
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[(select entry_id from public.list_trash(tests.i('home-a'), 'pets', 'pet'))])) = 'purged',
  'The pet is deleted for good');
select tests.assert_true(tests.trash_of('home-a', 'pet_medical_entry') = 0
  and tests.private_count(format($$select count(*) from private.pet_medical_entries where id = %L$$, tests.i('e-gone'))) = 0,
  'And its entry with it, leaving nothing in the trash');

-- Departure ------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(tests.grant_level('m-carol-a', 'view') = 'ok', 'Carol gets view again');
select tests.act_as('alice');
select public.remove_home_member(tests.i('home-a'), tests.i('m-carol-a'), 'member');
select tests.act_as_owner();
select tests.assert_true(tests.private_count($$select count(*) from private.pet_medical_access$$) = 1,
  'Her grant ends with her membership (only Bob''s remains)');
insert into public.home_memberships (home_id, user_id, role) values (tests.i('home-a'), tests.user_id('carol'), 'member');
select tests.act_as('carol');
select tests.assert_true((public.list_pets(tests.i('home-a')) -> 'medicalAccess') = 'null'::jsonb
  and tests.medical('p-rex') is null, 'Rejoining, she starts without medical access');

-- Losing manageHomePets
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array[]::text[]);
select tests.act_as('bob');
select tests.assert_true(tests.upd('p-rex', '{"name": "Rex"}') = 'not_permitted'
  and (tests.medical('p-rex') ->> 'level') = 'manage',
  'Without manageHomePets Bob no longer edits profiles; his medical access is its own grant');
