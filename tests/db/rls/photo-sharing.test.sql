-- S36: photo album sharing, removal and the photo widget (supabase/migrations/*_photo_sharing.sql).
-- Home A: Alice Owner, Bob Administrator, Carol Member. Home B: Carol Owner, Alice and Erin Members.
-- Home C: Dave Owner, Alice Member. Frank is in no Home.
-- Covers: shares unreachable as a table; who may share and where; view and contribute; contributions
-- keep their own library; contributors cannot share, rename, delete the album or others' photos;
-- unsharing one Home leaves the other; "Remove from this Home" never deletes the owner's photos (the
-- S36 done condition); Home exit revokes at once; album delete ends shares and restore does not bring
-- them back; Home album sharing by photo managers only; library deletion impact without hidden names;
-- delete and restore of a shared photo; the widget source rules.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '36000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '36000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'erin@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '36000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'frank@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('carol');
insert into ids select 'home-b', public.create_home('Oma', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('dave');
insert into ids select 'home-c', public.create_home('Studio', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('frank');
insert into ids select 'home-f', public.create_home('Elders', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
select h, tests.user_id(u), r from (values
  ('home-a', 'bob', 'administrator'), ('home-a', 'carol', 'member'),
  ('home-b', 'alice', 'member'), ('home-b', 'erin', 'member'),
  ('home-c', 'alice', 'member')) v(hn, u, r)
join ids on ids.name = v.hn
cross join lateral (select ids.id as h) x;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
create function tests.variants() returns jsonb
  language sql volatile as $$
  select jsonb_agg(jsonb_build_object('kind', k, 'size', 1000, 'width', 800, 'height', 600,
    'sha256', encode(extensions.digest(k || gen_random_uuid()::text, 'sha256'), 'hex')))
  from unnest(array['master', 'full', 'display', 'thumb']) k;
  $$;
create function tests.photo_of(p_file uuid) returns uuid
  language sql stable security definer as $$ select id from private.photos where file_id = p_file; $$;
-- Uploads and finalizes one photo as p_user into p_home ('' = personal).
create function tests.upload(p_name text, p_user text, p_home text) returns void
  language plpgsql as $$
  declare
    v record;
  begin
    perform tests.act_as(p_user);
    select * into v from public.create_photo_intent(
      case when p_home = '' then null else tests.i(p_home) end, 'image/jpeg', 100, gen_random_uuid());
    perform tests.act_as_service_role();
    perform public.finalize_photo(tests.user_id(p_user), v.file_id, tests.variants());
    insert into ids values (p_name, tests.photo_of(v.file_id));
    perform tests.act_as(p_user);
  end
  $$;
create function tests.lib(p_home text, p_album text default null) returns jsonb
  language plpgsql as $$
  begin
    return public.list_photo_library(case when p_home is null then null else tests.i(p_home) end,
      case when p_album is null then null else tests.i(p_album) end, 0);
  end $$;
create function tests.n(p_lib jsonb) returns integer
  language sql immutable as $$ select jsonb_array_length(p_lib -> 'photos'); $$;
create function tests.readable(p_photo text) returns boolean
  language sql as $$
  select exists (select 1 from public.authorize_photo_read(tests.i(p_photo), 'thumb')); $$;
create function tests.alive(p_photo text) returns boolean
  language sql stable security definer as $$
  select exists (select 1 from private.photos where id = tests.i(p_photo) and deleted_at is null); $$;
create function tests.revision(p_album text) returns integer
  language sql stable security definer as $$
  select revision from private.photo_albums where id = tests.i(p_album); $$;
create function tests.open_trash(p_item_type text) returns uuid
  language sql stable security definer as $$
  select id from private.trash_entries where item_type = p_item_type and status = 'trashed' limit 1; $$;
create function tests.share(p_album text, p_home text, p_access text) returns text
  language sql as $$
  select public.share_photo_album(tests.i(p_album),
    jsonb_build_array(jsonb_build_object('homeId', tests.i(p_home), 'access', p_access))) ->> 'outcome'; $$;
grant execute on function tests.photo_of(uuid), tests.i(text), tests.private_count(text), tests.variants(),
  tests.upload(text, text, text), tests.lib(text, text), tests.n(jsonb), tests.readable(text),
  tests.alive(text), tests.revision(text), tests.open_trash(text), tests.share(text, text, text)
  to authenticated, service_role;

insert into ids select n, gen_random_uuid() from unnest(array['al-p', 'al-a']) as n;

-- Nothing is reachable as a table -------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.photo_album_shares', 'The API cannot read shares');
select tests.act_as_anon();
select tests.assert_denied($$select public.share_photo_album(gen_random_uuid(), '[]')$$,
  'Nor can anyone signed out share');
select tests.act_as('alice');

-- A personal album, shared with two Homes ------------------------------------------------------------

select tests.upload('p1', 'alice', '');
select tests.upload('p2', 'alice', '');
select tests.upload('p3', 'alice', '');
select tests.act_as('alice');
select public.create_photo_album(tests.i('al-p'), null, 'Zomer');
select public.add_photos_to_album(tests.i('al-p'), array[tests.i('p1'), tests.i('p2')]);

select tests.act_as('bob');
select tests.assert_true(tests.share('al-p', 'home-a', 'view') = 'not_found',
  'Bob cannot share Alice''s personal album, nor learn it exists');
select tests.act_as('alice');
select tests.assert_denied($$select public.share_photo_album(tests.i('al-p'), jsonb_build_array(
    jsonb_build_object('homeId', tests.i('home-b'), 'access', 'view'),
    jsonb_build_object('homeId', tests.i('home-b'), 'access', 'contribute')))$$,
  'The same Home twice is refused', '22023');
select tests.assert_denied($$select public.share_photo_album(tests.i('al-p'), jsonb_build_array(
    jsonb_build_object('homeId', tests.i('home-b'), 'access', 'edit')))$$,
  'An unknown access is refused', '22023');
select tests.assert_true(tests.share('al-p', 'home-f', 'view') = 'not_permitted',
  'Alice cannot share into a Home she is not in');
select tests.assert_true(tests.private_count(
  'select count(*) from private.photo_album_shares') = 0, 'A refused share changes nothing');
select tests.assert_true((public.share_photo_album(tests.i('al-p'), jsonb_build_array(
    jsonb_build_object('homeId', tests.i('home-b'), 'access', 'contribute'),
    jsonb_build_object('homeId', tests.i('home-c'), 'access', 'view'))) ->> 'outcome') = 'saved',
  'Alice shares her album with Home B (contribute) and Home C (view)');
select tests.assert_true(jsonb_array_length(tests.lib(null, 'al-p') -> 'album' -> 'shares') = 2,
  'She sees both shares');
select tests.assert_true(tests.private_count('select count(*) from private.photos') = 3
  and tests.private_count('select count(*) from private.stored_files where purpose = ''photo''') = 3,
  'Nothing was copied');

-- What each audience sees ------------------------------------------------------------------------------

select tests.act_as('erin');
select tests.assert_true(jsonb_array_length(tests.lib('home-b') -> 'sharedAlbums') = 1
  and (tests.lib('home-b') -> 'sharedAlbums' -> 0 ->> 'access') = 'contribute',
  'Erin sees the album on Home B''s page, with contribute access');
select tests.assert_true(tests.n(tests.lib('home-b', 'al-p')) = 2, 'And its two photos');
select tests.assert_true(tests.readable('p1') and not tests.readable('p3'),
  'She may read a photo of the album, not one of Alice''s other personal photos');
select tests.assert_true(public.get_photo(tests.i('p3')) is null, 'Nor learn that one exists');
select tests.assert_true(tests.lib('home-b', 'al-p') -> 'album' -> 'shares' = '[]'::jsonb
  and (tests.lib('home-b', 'al-p') -> 'album' ->> 'canShare') = 'false',
  'She does not see the album''s other audiences and cannot share it');
select tests.assert_true(tests.lib('home-c', 'al-p') is null, 'Erin is not in Home C: nothing there');
select tests.act_as('dave');
select tests.assert_true(tests.n(tests.lib('home-c', 'al-p')) = 2 and tests.readable('p2'),
  'Dave sees the album through Home C');
select tests.act_as('frank');
select tests.assert_true(not tests.readable('p1') and public.get_photo(tests.i('p1')) is null,
  'Frank sees nothing');
select tests.assert_true(tests.lib('home-f') -> 'sharedAlbums' = '[]'::jsonb, 'No shared album in his Home');
select tests.act_as('carol');
select tests.assert_true(tests.lib('home-a', 'al-p') is null,
  'A personal album shared with Home B is not shown on Home A''s page');

-- Contributions -----------------------------------------------------------------------------------------

select tests.upload('e1', 'erin', 'home-b');
select tests.upload('ep1', 'erin', '');
select tests.upload('c1', 'carol', 'home-b');
select tests.act_as('erin');
select tests.assert_true((public.add_photos_to_album(tests.i('al-p'),
    array[tests.i('e1'), tests.i('ep1'), tests.i('c1'), tests.i('p3')]) ->> 'added') = '2',
  'Erin adds her Home B photo and her personal photo; Carol''s and Alice''s are skipped');
select tests.assert_true(exists (select 1 from jsonb_array_elements(tests.lib('home-b') -> 'targets') t
    where t ->> 'id' = tests.i('al-p')::text and (t ->> 'shared')::boolean),
  'The album is offered as a target on Home B''s page, marked as shared outside');
select tests.upload('d1', 'dave', 'home-c');
select tests.act_as('dave');
select tests.assert_true((public.add_photos_to_album(tests.i('al-p'), array[tests.i('d1')]) ->> 'outcome')
  = 'not_permitted', 'View-only Dave cannot add photos');
select tests.assert_true(not exists (select 1 from jsonb_array_elements(tests.lib('home-c') -> 'targets') t
  where t ->> 'id' = tests.i('al-p')::text), 'Nor is it offered to him');
select tests.assert_true(tests.n(tests.lib('home-c', 'al-p')) = 4 and tests.readable('e1') and tests.readable('ep1'),
  'Dave sees Erin''s contributions too: one album for every audience');
select tests.assert_true(not tests.readable('c1'), 'But not Home B''s other photos');
select tests.act_as('alice');
select tests.assert_true(tests.n(tests.lib(null, 'al-p')) = 4, 'Alice sees all four in her album');
select tests.assert_true(tests.private_count(format(
    'select count(*) from private.photos where id = %L and owner_home_id = %L', tests.i('e1'), tests.i('home-b'))) = 1,
  'Erin''s photo stays in Home B''s library');
select tests.assert_true((public.delete_photos(array[tests.i('e1')]) ->> 'skipped') = '1',
  'Alice cannot delete Erin''s photo from its library');

select tests.act_as('erin');
select tests.assert_true((public.share_photo_album(tests.i('al-p'), jsonb_build_array(jsonb_build_object(
  'homeId', tests.i('home-b'), 'access', 'view'))) ->> 'outcome') <> 'saved', 'A contributor cannot change sharing');
select tests.assert_true((public.rename_photo_album(tests.i('al-p'), tests.revision('al-p'), 'Mijn') ->> 'outcome')
  <> 'saved', 'Nor rename the album');
select tests.assert_true((public.delete_photo_album(tests.i('al-p'), tests.revision('al-p')) ->> 'outcome')
  <> 'deleted', 'Nor delete it');
select tests.assert_true((public.delete_photos(array[tests.i('p1')]) ->> 'skipped') = '1',
  'Nor delete Alice''s source photo');
select tests.assert_true((public.remove_photos_from_album(tests.i('al-p'), array[tests.i('p1')]) ->> 'outcome')
  = 'not_permitted', 'Nor take Alice''s photo out of the album');
select tests.assert_true((public.unshare_photo_album(tests.i('al-p'), tests.i('home-c')) ->> 'outcome')
  = 'not_permitted', 'Nor end the share with Home C, which she is not in');
select tests.assert_true((public.remove_photos_from_album(tests.i('al-p'), array[tests.i('e1')]) ->> 'removed') = '1',
  'She takes her own photo out of the album');
select tests.assert_true(tests.alive('e1') and tests.n(tests.lib('home-b')) = 2,
  'Removing from the album kept the photo in Home B''s library');
select public.add_photos_to_album(tests.i('al-p'), array[tests.i('e1')]);
select tests.assert_true(exists (select 1 from jsonb_array_elements(tests.lib('home-b', 'al-p') -> 'photos') p
    where p ->> 'id' = tests.i('e1')::text and (p ->> 'canRemove')::boolean)
  and exists (select 1 from jsonb_array_elements(tests.lib('home-b', 'al-p') -> 'photos') p
    where p ->> 'id' = tests.i('p1')::text and not (p ->> 'canRemove')::boolean),
  'The page offers "Remove from this album" only where she may');

-- Unshare one Home; remove the album from another --------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true((public.unshare_photo_album(tests.i('al-p'), tests.i('home-c')) ->> 'outcome') = 'removed',
  'Alice stops sharing with Home C');
select tests.act_as('dave');
select tests.assert_true(not tests.readable('p1') and tests.lib('home-c', 'al-p') is null
  and tests.lib('home-c') -> 'sharedAlbums' = '[]'::jsonb, 'Dave loses access at once');
select tests.act_as('erin');
select tests.assert_true(tests.n(tests.lib('home-b', 'al-p')) = 4, 'Home B keeps its access');

select tests.assert_true((public.unshare_photo_album(tests.i('al-p'), tests.i('home-b')) ->> 'outcome')
  = 'not_permitted', 'Erin, a plain member of Home B, cannot remove the album from it');
select tests.act_as('carol');
select tests.assert_true((public.unshare_photo_album(tests.i('al-p'), tests.i('home-b')) ->> 'outcome') = 'removed',
  'Carol, Home B''s Owner, removes the shared album from Home B');
select tests.assert_true(tests.alive('p1') and tests.alive('p2') and tests.alive('p3'),
  'Removing the shared album from Home B deleted none of Alice''s photos');
select tests.assert_true(tests.alive('e1') and tests.alive('ep1'), 'Nor Erin''s photos');
select tests.act_as('alice');
select tests.assert_true(tests.n(tests.lib(null, 'al-p')) = 2 and tests.n(tests.lib(null)) = 3,
  'Alice''s album holds her two photos again and her library is whole');
select tests.assert_true((tests.lib(null) -> 'albums' -> 0 ->> 'shareCount') = '0', 'The album is no longer shared');
select tests.act_as('erin');
select tests.assert_true(not tests.readable('p1') and tests.lib('home-b', 'al-p') is null,
  'Erin no longer sees Alice''s photos');
select tests.assert_true(tests.n(tests.lib('home-b')) = 2 and tests.readable('ep1'),
  'Her own photos are still hers');

-- Home exit revokes at once ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.share('al-p', 'home-b', 'contribute');
select tests.act_as('erin');
select public.add_photos_to_album(tests.i('al-p'), array[tests.i('ep1')]);
select tests.act_as('alice');
select tests.assert_true(tests.n(tests.lib(null, 'al-p')) = 3, 'Erin''s personal photo is back in the album');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-b') and user_id = tests.user_id('erin');
select tests.act_as('erin');
select tests.assert_true(not tests.readable('p1'), 'Leaving Home B, Erin loses the album at once');
select tests.act_as('alice');
select tests.assert_true(tests.n(tests.lib(null, 'al-p')) = 2 and not tests.readable('ep1'),
  'And her personal photo no longer shows to the album''s audience');
select tests.act_as('erin');
select tests.assert_true(tests.alive('ep1') and tests.readable('ep1'), 'It is not deleted');

-- Library deletion: impact, delete, restore ---------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true((public.photo_deletion_impact(array[tests.i('p1')]) ->> 'deletable') = '1'
  and public.photo_deletion_impact(array[tests.i('p1')]) -> 'albums' = '["Zomer"]'::jsonb
  and public.photo_deletion_impact(array[tests.i('p1')]) -> 'sharedHomes' = '["Oma"]'::jsonb,
  'The impact preview names the album and the Home that loses access');
select tests.assert_true(tests.private_count('select count(*) from private.photos where deleted_at is not null') = 0,
  'Asking for the impact changes nothing');
select tests.act_as('carol');
select tests.assert_true((public.photo_deletion_impact(array[tests.i('p1')]) ->> 'deletable') = '0',
  'Carol may not delete Alice''s photo: the preview says so');
select tests.upload('c2', 'carol', 'home-b');
select tests.act_as('carol');
insert into ids select 'al-b', gen_random_uuid();
select public.create_photo_album(tests.i('al-b'), tests.i('home-b'), 'Geheim');
select public.add_photos_to_album(tests.i('al-b'), array[tests.i('c2')]);
select public.add_photos_to_album(tests.i('al-p'), array[tests.i('c2')]);
select tests.act_as('alice');
select tests.assert_true((public.photo_deletion_impact(array[tests.i('p1')]) ->> 'otherAlbums') = 'false',
  'No hidden album holds p1');

select tests.assert_true((public.delete_photos(array[tests.i('p1')]) ->> 'deleted') = '1', 'Alice deletes p1');
select tests.act_as('carol');
select tests.assert_true(not tests.readable('p1') and tests.n(tests.lib('home-b', 'al-p')) = 2,
  'It is gone from the shared album at once');
select tests.act_as('alice');
select tests.assert_true((select outcome from public.restore_trash_entries(array[tests.open_trash('photo')])) = 'restored',
  'She restores it');
select tests.act_as('carol');
select tests.assert_true(tests.readable('p1') and tests.n(tests.lib('home-b', 'al-p')) = 3,
  'It is back in the album, which is still shared');

-- Album delete ends shares; restore does not bring them back -----------------------------------------------

select tests.act_as('alice');
select tests.assert_true((public.delete_photo_album(tests.i('al-p'), tests.revision('al-p')) ->> 'outcome') = 'deleted',
  'Alice deletes the album');
select tests.assert_true(tests.private_count('select count(*) from private.photo_album_shares') = 0,
  'Its shares ended');
select tests.assert_true(tests.alive('p1') and tests.alive('c2'), 'No photo was deleted');
select tests.assert_true((select outcome from public.restore_trash_entries(array[tests.open_trash('photo_album')]))
  = 'restored', 'She restores the album');
select tests.act_as('carol');
select tests.assert_true(tests.lib('home-b', 'al-p') is null and not tests.readable('p1'),
  'Restoring did not bring the share back');

-- A Home album: photo managers share it -------------------------------------------------------------------

select tests.act_as('carol');
select public.create_photo_album(tests.i('al-a'), tests.i('home-a'), 'Tuin');
select tests.assert_true(tests.share('al-a', 'home-b', 'view') = 'not_permitted',
  'Carol created the Home A album but is not a photo manager: she cannot share it');
select tests.act_as('bob');
select tests.assert_true(tests.share('al-a', 'home-b', 'view') = 'not_permitted',
  'Bob, an Administrator without manageHomePhotos and not in Home B, cannot either');
select tests.upload('a1', 'carol', 'home-a');
select tests.act_as('carol');
select public.add_photos_to_album(tests.i('al-a'), array[tests.i('a1')]);
select tests.act_as('alice');
select tests.assert_true(tests.share('al-a', 'home-a', 'view') = 'not_permitted',
  'An album is never shared with its own Home');
select tests.assert_true(tests.share('al-a', 'home-b', 'view') = 'saved', 'Alice, Home A''s Owner, shares it with Home B');
select tests.act_as('carol');
select tests.assert_true((tests.lib('home-b') -> 'sharedAlbums' -> 0 ->> 'ownerHomeName') = 'Thuis',
  'Home B''s page names the owning Home');
select tests.assert_true(exists (select 1 from jsonb_array_elements(tests.lib('home-b') -> 'targets') t
    where t ->> 'id' = tests.i('al-a')::text),
  'As the album''s creator and Home B''s Owner, Carol may add Home B photos to it even at view access');
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values (tests.i('home-b'), tests.user_id('erin'), 'member');
select tests.upload('e2', 'erin', 'home-b');
select tests.act_as('erin');
select tests.assert_true(tests.readable('a1'), 'Back in Home B, Erin sees the Home A album''s photo');
select tests.assert_true((public.add_photos_to_album(tests.i('al-a'), array[tests.i('e2')]) ->> 'outcome')
  = 'not_permitted', 'A plain member cannot add to a view-only shared album');

-- The photo widget ----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.share('al-p', 'home-b', 'view');
select tests.act_as('carol');
select tests.assert_true((public.resolve_photo_widget(tests.i('home-b'), tests.i('al-p'), null) ->> 'available') = 'true'
  and jsonb_array_length(public.resolve_photo_widget(tests.i('home-b'), tests.i('al-p'), null) -> 'photos') = 2,
  'A Home B widget may show the album shared with Home B');
select tests.assert_true((public.resolve_photo_widget(null, tests.i('al-p'), null) ->> 'available') = 'false',
  'Not on Carol''s personal dashboard: shared albums are not personal');
select tests.assert_true((public.resolve_photo_widget(tests.i('home-a'), tests.i('al-p'), null) ->> 'available') = 'false',
  'Nor on Home A''s dashboard, which it is not shared with');
select tests.assert_true(public.resolve_photo_widget(tests.i('home-b'), null,
    array[tests.i('p2'), tests.i('c1'), tests.i('p3')]) -> 'photos' -> 0 ->> 'id' = tests.i('p2')::text
  and (public.resolve_photo_widget(tests.i('home-b'), null,
    array[tests.i('p2'), tests.i('c1'), tests.i('p3')]) ->> 'missing') = '1',
  'Picked photos keep their order; one never shared with Home B is missing, not replaced');
select tests.assert_true((public.resolve_photo_widget(null, null, array[tests.i('c1')]) ->> 'missing') = '1',
  'A Home photo is never shown on a personal dashboard');
select tests.assert_denied($$select public.resolve_photo_widget(null, null, null)$$, 'A widget needs a source', '22023');
select tests.act_as('frank');
select tests.assert_true(public.resolve_photo_widget(tests.i('home-b'), tests.i('al-p'), null) is null,
  'Frank is not in Home B: nothing');
select tests.act_as('alice');
select public.delete_photos(array[tests.i('p2')]);
select tests.act_as('carol');
select tests.assert_true((public.resolve_photo_widget(tests.i('home-b'), null, array[tests.i('p2')]) ->> 'missing') = '1',
  'A deleted photo stops showing in widgets at once');

-- Review fixes: the impact names the owner side of a contribution; recipients get no share count;
-- leaving a Home ends the shares of one's personal albums with it -----------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.readable('c2') and exists (
    select 1 from jsonb_array_elements(tests.lib('home-b', 'al-p') -> 'photos') p where p ->> 'id' = tests.i('p1')::text),
  'Carol sees Alice''s album through Home B');
select tests.assert_true((tests.lib('home-b', 'al-p') -> 'album' ->> 'shareCount') = '0',
  'A recipient does not learn how many Homes see the album');
select public.add_photos_to_album(tests.i('al-p'), array[tests.i('c1')]);
select tests.act_as('alice');
select tests.share('al-p', 'home-b', 'contribute');
select tests.act_as('carol');
select public.add_photos_to_album(tests.i('al-p'), array[tests.i('c1')]);
select tests.assert_true((public.photo_deletion_impact(array[tests.i('c1')]) ->> 'otherHomes') = 'true',
  'Deleting a photo added to another person''s album flags that others lose it, without a name');
select tests.act_as('alice');
select tests.share('al-p', 'home-c', 'view');
select tests.act_as('dave');
select tests.assert_true(tests.readable('p1'), 'Dave sees the album through Home C again');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-c') and user_id = tests.user_id('alice');
select tests.act_as('dave');
select tests.assert_true(not tests.readable('p1') and tests.lib('home-c') -> 'sharedAlbums' = '[]'::jsonb,
  'When Alice leaves Home C, her personal album is no longer shared with it');
select tests.assert_true(tests.alive('p1') and tests.alive('d1'), 'Nothing was deleted');
