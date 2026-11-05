-- S35: photo libraries (supabase/migrations/*_photos.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Dave is in no Home.
-- Covers: nothing reachable as a table; upload intents (personal, Home, outsider, invalid type and
-- size, idempotent request id, full pool); finalize only for the server, with the derivatives counted
-- against the pool; reads (personal library private, Home library for members, forged ids); delete to
-- the trash with the file still counted, restore, early purge; albums (create, rename, stale,
-- multi-album membership, removal never deletes the photo, cross-library add refused, delete and
-- restore); manageHomePhotos; objects of every derivative queued for removal when a photo is purged.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '35000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
create function tests.variants(p_size bigint default 1000) returns jsonb
  language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('kind', 'master', 'size', p_size, 'width', 2560, 'height', 1440,
      'sha256', encode(extensions.digest('master' || p_size, 'sha256'), 'hex')),
    jsonb_build_object('kind', 'full', 'size', p_size, 'width', 1920, 'height', 1080,
      'sha256', encode(extensions.digest('full' || p_size, 'sha256'), 'hex')),
    jsonb_build_object('kind', 'display', 'size', p_size, 'width', 1024, 'height', 576,
      'sha256', encode(extensions.digest('display' || p_size, 'sha256'), 'hex')),
    jsonb_build_object('kind', 'thumb', 'size', p_size, 'width', 320, 'height', 180,
      'sha256', encode(extensions.digest('thumb' || p_size, 'sha256'), 'hex')));
  $$;
-- Uploads and finalizes one photo as p_user into p_home ('' = personal); returns the outcome.
create function tests.upload(p_name text, p_user text, p_home text, p_size bigint default 1000) returns text
  language plpgsql as $$
  declare
    v record;
    v_outcome text;
  begin
    perform tests.act_as(p_user);
    select * into v from public.create_photo_intent(
      case when p_home = '' then null else tests.i(p_home) end, 'image/heic', 100, gen_random_uuid());
    if v.outcome <> 'ok' then
      return v.outcome;
    end if;
    insert into ids values ('f-' || p_name, v.file_id);
    perform tests.act_as_service_role();
    v_outcome := public.finalize_photo(tests.user_id(p_user), v.file_id, tests.variants(p_size));
    perform tests.act_as(p_user);
    if v_outcome = 'ready' then
      insert into ids values (p_name, tests.photo_of(v.file_id));
    end if;
    return v_outcome;
  end
  $$;
create function tests.photo_of(p_file uuid) returns uuid
  language sql stable security definer as $$ select id from private.photos where file_id = p_file; $$;
create function tests.lib(p_home text default null, p_album text default null) returns jsonb
  language plpgsql as $$
  begin
    return public.list_photo_library(case when p_home is null then null else tests.i(p_home) end,
      case when p_album is null then null else tests.i(p_album) end, 0);
  end $$;
create function tests.n(p_lib jsonb) returns integer
  language sql immutable as $$ select jsonb_array_length(p_lib -> 'photos'); $$;
create function tests.used(p_user text) returns bigint
  language plpgsql security definer as $$
  declare v bigint;
  begin
    select ready_bytes + deleted_bytes into v from private.storage_usage((
      select id from private.storage_pools where owner_user_id = tests.user_id(p_user)));
    return v;
  end $$;
create function tests.used_home(p_home text) returns bigint
  language plpgsql security definer as $$
  declare v bigint;
  begin
    select ready_bytes + deleted_bytes into v from private.storage_usage((
      select id from private.storage_pools where owner_home_id = tests.i(p_home)));
    return v;
  end $$;
create function tests.open_trash(p_item_type text) returns uuid
  language sql stable security definer as $$
  select id from private.trash_entries where item_type = p_item_type and status = 'trashed' limit 1; $$;
grant execute on function tests.photo_of(uuid), tests.i(text), tests.private_count(text), tests.variants(bigint),
  tests.upload(text, text, text, bigint), tests.lib(text, text), tests.n(jsonb), tests.used(text), tests.used_home(text),
  tests.open_trash(text) to authenticated, service_role;

insert into ids select n, gen_random_uuid() from unnest(array['al-1', 'al-2', 'al-home', 'al-x']) as n;

-- Nothing is reachable as a table -------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.photos', 'The API cannot read photos');
select tests.assert_denied('select * from private.photo_variants', 'Nor derivatives');
select tests.assert_denied('select * from private.photo_albums', 'Nor albums');
select tests.assert_denied('select * from private.photo_album_items', 'Nor memberships');
select tests.assert_denied($$select public.finalize_photo(gen_random_uuid(), gen_random_uuid(), '[]')$$,
  'Signed-in people cannot finalize: only the server can');
select tests.act_as_anon();
select tests.assert_denied($$select public.list_photo_library(null, null, 0)$$, 'Nor can anyone signed out');

-- Intents ---------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied($$select * from public.create_photo_intent(null, 'application/pdf', 1000, gen_random_uuid())$$,
  'A PDF is not a photo', '22023');
select tests.assert_denied($$select * from public.create_photo_intent(null, 'image/jpeg', 26214401, gen_random_uuid())$$,
  'Over 25 MB is refused', '22023');
select tests.assert_denied($$select * from public.create_photo_intent(null, 'image/jpeg', 0, gen_random_uuid())$$,
  'An empty file is refused', '22023');
select tests.assert_true((select outcome from public.create_photo_intent(tests.i('home-a'), 'image/gif', 1000,
  gen_random_uuid())) = 'ok', 'Any format of the list is accepted for a Home');
select tests.act_as('dave');
select tests.assert_true((select outcome from public.create_photo_intent(tests.i('home-a'), 'image/jpeg', 1000,
  gen_random_uuid())) = 'not_permitted', 'Dave cannot upload into a Home he is not in');
select tests.act_as('alice');
do $$
declare
  v_request uuid := gen_random_uuid();
  a record;
  b record;
begin
  select * into a from public.create_photo_intent(null, 'image/jpeg', 1000, v_request);
  select * into b from public.create_photo_intent(null, 'image/jpeg', 1000, v_request);
  perform tests.assert_true(a.file_id = b.file_id, 'The same request id returns the same upload');
  perform tests.assert_true((select outcome from public.create_photo_intent(null, 'image/png', 1000, v_request)) = 'conflict',
    'The same request id with other facts conflicts');
  perform tests.assert_true(tests.private_count(format(
    'select count(*) from private.photo_variants where file_id = %L', a.file_id)) = 3,
    'Three derivative keys are generated with the upload');
  perform tests.assert_true((select count(*) from public.get_photo_upload_keys(a.file_id)) = 4,
    'The uploader gets four keys');
end $$;
-- Finalize and quota -----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.upload('a-1', 'alice', '') = 'ready', 'Alice uploads a personal photo');
select tests.assert_true(tests.used('alice') = 4000,
  'Master and three derivatives count together against her personal pool');
select tests.assert_true(tests.upload('a-2', 'alice', '') = 'ready', 'And another');
select tests.assert_true(tests.upload('h-1', 'carol', 'home-a') = 'ready', 'Carol, a member, uploads to the Home');
select tests.assert_true(tests.used('carol') = 0 or tests.used('carol') is null, 'It is not charged to Carol');
select tests.assert_true(tests.used_home('home-a') >= 4000, 'It is charged to the Home pool');
select tests.assert_true(tests.upload('h-2', 'bob', 'home-a') = 'ready', 'Bob uploads one too');
select tests.assert_true(tests.upload('d-1', 'dave', 'home-a') = 'not_permitted', 'Dave cannot upload to Home A');

do $$
declare
  v record;
  v_bad text;
begin
  perform tests.act_as('alice');
  select * into v from public.create_photo_intent(null, 'image/jpeg', 1000, gen_random_uuid());
  perform tests.act_as_service_role();
  v_bad := public.finalize_photo(tests.user_id('alice'), v.file_id, '[]'::jsonb);
  perform tests.assert_true(v_bad = 'invalid', 'Finalize refuses derivatives that are not exactly the four');
  perform tests.assert_true(tests.private_count(format(
    'select count(*) from private.stored_files where id = %L and status = ''failed''', v.file_id)) = 1,
    'The file is failed');
  perform tests.assert_true(tests.private_count(format(
    'select count(*) from private.storage_object_deletions d join private.photo_variants pv on pv.object_key = d.object_key
     where pv.file_id = %L', v.file_id)) = 3, 'Its derivative objects are queued for removal');
  perform tests.assert_true(public.finalize_photo(tests.user_id('bob'), v.file_id, tests.variants()) = 'not_found',
    'Someone else cannot finalize it');
end $$;

-- A full pool refuses an upload and a finalize.
select tests.act_as_owner();
select private.lock_storage_pool(tests.user_id('carol'), null);
update private.storage_pools set allowance_bytes = 4500 where owner_user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_true(tests.upload('c-1', 'carol', '', 1000) = 'ready', 'Carol fills her personal pool');
select tests.assert_true((select outcome from public.create_photo_intent(null, 'image/jpeg', 1000, gen_random_uuid()))
  = 'storage_full', 'A full pool refuses the next upload');
select tests.act_as_owner();
update private.storage_pools set allowance_bytes = 4000 + 4500 where owner_user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_true(tests.upload('c-2', 'carol', '', 3000) = 'storage_full',
  'A finalize whose pictures together exceed the room is refused');

-- Reading --------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.n(tests.lib()) = 2 and (tests.lib() ->> 'total')::int = 2,
  'Alice sees her two personal photos');
select tests.act_as('bob');
select tests.assert_true(tests.n(tests.lib()) = 0, 'Bob does not see them in his own library');
select tests.assert_true(public.get_photo(tests.i('a-1')) is null
  and (select count(*) from public.authorize_photo_read(tests.i('a-1'), 'thumb')) = 0,
  'A personal photo is not found by id for anyone else');
select tests.assert_true(tests.n(tests.lib('home-a')) = 2, 'Bob sees the Home library: two photos');
select tests.act_as('carol');
select tests.assert_true(tests.n(tests.lib('home-a')) = 2 and (tests.lib('home-a') -> 'photos' -> 0 ->> 'canDelete') is not null,
  'Carol sees the Home library');
select tests.act_as('dave');
select tests.assert_true(tests.lib('home-a') is null, 'Dave gets nothing for a Home he is not in');
select tests.assert_true(public.get_photo(tests.i('h-1')) is null
  and (select count(*) from public.authorize_photo_read(tests.i('h-1'), 'master')) = 0,
  'Nor for its photos');
select tests.act_as('bob');
select tests.assert_true((select count(*) from public.authorize_photo_read(tests.i('h-1'), 'master')) = 1
  and (select count(*) from public.authorize_photo_read(tests.i('h-1'), 'thumb')) = 1
  and (select count(*) from public.authorize_photo_read(tests.i('h-1'), 'huge')) = 0,
  'A member reads the master and each derivative of a Home photo, nothing else');
select tests.assert_true(tests.lib('home-a', 'al-x') is null, 'A forged album id answers nothing');

-- Deleting photos and the trash ------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((public.delete_photos(array[tests.i('h-2')]) ->> 'deleted') = '0',
  'A member cannot delete another member''s Home photo');
select tests.assert_true((public.delete_photos(array[tests.i('a-1')]) ->> 'skipped') = '1',
  'Nor a personal photo of someone else (skipped without telling why)');
select tests.assert_true((public.delete_photos(array[tests.i('h-1')]) ->> 'deleted') = '1',
  'She deletes her own');
select tests.assert_true(tests.n(tests.lib('home-a')) = 1 and public.get_photo(tests.i('h-1')) is null
  and (select count(*) from public.authorize_photo_read(tests.i('h-1'), 'thumb')) = 0,
  'It is gone from the library and unreadable');
select tests.assert_true(tests.used_home('home-a') >= 8000,
  'But all four pictures still count against the Home pool for seven days');
select tests.act_as('bob');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'), 'photos', 'photo')) = 0,
  'Bob, an Administrator without manageHomePhotos, does not see her trash entry');
select tests.act_as('alice');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'), 'photos', 'photo')) = 1,
  'The Owner does');
select tests.act_as('carol');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'), 'photos', 'photo')) = 1,
  'Carol sees her own');
select tests.assert_true((select outcome from public.restore_trash_entries(array[tests.open_trash('photo')])) = 'restored',
  'She restores it');
select tests.assert_true(tests.n(tests.lib('home-a')) = 2 and tests.used_home('home-a') >= 8000,
  'It is back, and not counted twice');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomePhotos']);
select tests.act_as('bob');
select tests.assert_true((public.delete_photos(array[tests.i('h-1')]) ->> 'deleted') = '1',
  'Granted manageHomePhotos, Bob deletes anyone''s Home photo');
select tests.assert_true((select count(*) from public.list_trash(tests.i('home-a'), 'photos', 'photo')) = 1,
  'And sees the trash entry');
select tests.assert_true((select outcome from public.purge_trash_entries(array[tests.open_trash('photo')])) = 'purged',
  'He deletes it permanently');
select tests.assert_true(tests.private_count(format(
  'select count(*) from private.storage_object_deletions d join private.photo_variants pv on pv.object_key = d.object_key
   where pv.file_id = %L', tests.i('f-h-1'))) = 3
  and tests.private_count(format(
  'select count(*) from private.storage_object_deletions d join private.stored_files f on f.object_key = d.object_key
   where f.id = %L', tests.i('f-h-1'))) = 1,
  'All four objects of a purged photo are queued for removal');
select tests.assert_true(tests.used_home('home-a') < 8000, 'Its space is released');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array[]::text[]);

-- Albums ---------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true((public.create_photo_album(tests.i('al-1'), null, '  Zomer   2026 ') ->> 'outcome') = 'created',
  'Alice creates a personal album (name tidied)');
select tests.assert_true((public.create_photo_album(tests.i('al-1'), null, 'Zomer 2026') ->> 'outcome') = 'exists',
  'A retry returns the same album');
select tests.assert_denied($$select public.create_photo_album(gen_random_uuid(), null, '   ')$$, 'A blank name is refused', '22023');
select tests.assert_denied($$select public.create_photo_album(gen_random_uuid(), null, repeat('x', 81))$$,
  'An 81-character name is refused', '22023');
select tests.assert_true((public.create_photo_album(tests.i('al-2'), null, 'Favorieten') ->> 'outcome') = 'created', 'A second album');
select tests.assert_true((public.add_photos_to_album(tests.i('al-1'), array[tests.i('a-1'), tests.i('a-2')]) ->> 'added') = '2',
  'She adds two photos');
select tests.assert_true((public.add_photos_to_album(tests.i('al-2'), array[tests.i('a-1')]) ->> 'added') = '1',
  'One photo can be in more than one album');
select tests.assert_true((public.add_photos_to_album(tests.i('al-1'), array[tests.i('a-1')]) ->> 'added') = '0',
  'Adding twice changes nothing');
select tests.assert_true((public.add_photos_to_album(tests.i('al-2'), array[tests.i('h-2')]) ->> 'added') = '0',
  'A Home photo cannot join a personal album');
select tests.assert_true(tests.n(tests.lib(null, 'al-1')) = 2 and tests.n(tests.lib(null, 'al-2')) = 1
  and jsonb_array_length(public.get_photo(tests.i('a-1')) -> 'albums') = 2,
  'Albums list their photos; the photo lists its albums');
select tests.assert_true((public.remove_photos_from_album(tests.i('al-1'), array[tests.i('a-1')]) ->> 'removed') = '1'
  and tests.n(tests.lib()) = 2 and tests.n(tests.lib(null, 'al-1')) = 1,
  'Removing a photo from an album does not delete it');
select tests.assert_true((public.rename_photo_album(tests.i('al-1'), 1, 'Winter') ->> 'outcome') = 'saved'
  and (public.rename_photo_album(tests.i('al-1'), 1, 'Late') ->> 'outcome') = 'stale', 'Renames are revision-checked');
select tests.act_as('bob');
select tests.assert_true((public.rename_photo_album(tests.i('al-1'), 2, 'Mine') ->> 'outcome') = 'not_found'
  and (public.add_photos_to_album(tests.i('al-1'), array[tests.i('a-1')]) ->> 'outcome') = 'not_found'
  and (public.delete_photo_album(tests.i('al-1'), 2) ->> 'outcome') = 'not_found',
  'Someone else''s personal album is not found, for every action');
select tests.act_as('alice');
select tests.assert_true((public.delete_photos(array[tests.i('a-2')]) ->> 'deleted') = '1'
  and (select (x ->> 'photoCount')::int from jsonb_array_elements(tests.lib() -> 'albums') x
    where x ->> 'id' = tests.i('al-1')::text) = 0,
  'Deleting a photo hides it from its albums');
select tests.assert_true((public.delete_photo_album(tests.i('al-1'), 2) ->> 'outcome') = 'deleted'
  and tests.n(tests.lib()) = 1 and tests.lib(null, 'al-1') is null,
  'Deleting an album leaves the photos');
select tests.assert_true((select outcome from public.restore_trash_entries(array[tests.open_trash('photo_album')])) = 'restored'
  and tests.lib(null, 'al-1') is not null, 'The album comes back');
select tests.assert_true((select outcome from public.restore_trash_entries(array[tests.open_trash('photo')])) = 'restored'
  and tests.n(tests.lib(null, 'al-1')) = 1 and tests.n(tests.lib()) = 2,
  'The photo comes back to the library and to its album');

-- Home albums follow the Home's rules.
select tests.act_as('carol');
select tests.assert_true((public.create_photo_album(tests.i('al-home'), tests.i('home-a'), 'Gezin') ->> 'outcome') = 'created',
  'A member creates a Home album');
select tests.act_as('dave');
select tests.assert_true((public.create_photo_album(gen_random_uuid(), tests.i('home-a'), 'Hack') ->> 'outcome') = 'not_permitted',
  'An outsider cannot');
select tests.act_as('bob');
select tests.assert_true((public.rename_photo_album(tests.i('al-home'), 1, 'Bob') ->> 'outcome') = 'not_permitted'
  and tests.n(tests.lib('home-a', 'al-home')) = 0, 'Another member cannot change it, but sees it');
select tests.act_as('carol');
select tests.assert_true((public.add_photos_to_album(tests.i('al-home'), array[tests.i('h-2')]) ->> 'added') = '1',
  'The creator adds Home photos to it');
select tests.act_as('alice');
select tests.assert_true((public.rename_photo_album(tests.i('al-home'), 1, 'Familie') ->> 'outcome') = 'saved',
  'The Owner manages every Home album');
select tests.act_as('dave');
select tests.assert_true(tests.lib('home-a', 'al-home') is null, 'Outsiders find nothing');

-- Audit carries ids only -----------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(tests.private_count($$select count(*) from private.audit_events
  where subject_type in ('photo', 'photo_album') and details::text ~* '(zomer|winter|gezin|familie)'$$) = 0,
  'The audit trail names no album');
