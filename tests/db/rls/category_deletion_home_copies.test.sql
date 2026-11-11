-- S40 (part 2): deleting personal data by category and copying personal items into Homes
-- (supabase/migrations/20261128090000_category_deletion_home_copies.sql).

create function tests.cd_account(p_email text) returns uuid
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

create function tests.cd_grant(p_user uuid, p_action text) returns void
  language sql
  as $$
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (p_user, p_action, tests.session_id(p_user), now() + interval '1 minute')
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at
  $$;

-- A ready file of p_size bytes in a person's (p_home null) or a Home's pool.
create function tests.cd_file(p_user uuid, p_home uuid, p_purpose text, p_size bigint) returns uuid
  language plpgsql
  as $$
  declare
    v_pool private.storage_pools := private.lock_storage_pool(
      case when p_home is null then p_user end, p_home);
    v_id uuid;
  begin
    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type, declared_size,
      content_type, size_bytes, sha256, status, expires_at, finalized_at)
    values (
      v_pool.id, p_purpose, p_user, gen_random_uuid(),
      private.new_object_key(case when p_home is null then 'u' else 'h' end),
      private.new_object_key(case when p_home is null then 'u' else 'h' end),
      'image/jpeg', p_size, 'image/jpeg', p_size, repeat('c', 64), 'ready', now(), now())
    returning id into v_id;
    return v_id;
  end
  $$;

-- A person's own photo (file and three variants) put in an album.
create function tests.cd_photo(p_user uuid, p_album uuid) returns uuid
  language plpgsql
  as $$
  declare
    v_file uuid := tests.cd_file(p_user, null, 'photo', 1000);
    v_photo uuid := gen_random_uuid();
  begin
    insert into private.photo_variants (file_id, kind, object_key, size_bytes, width, height, sha256)
      select v_file, k, private.new_object_key('u'), 100, 10, 10, repeat('d', 64)
        from unnest(array['full', 'display', 'thumb']) k;
    insert into private.photos (id, file_id, owner_user_id, created_by, width, height)
      values (v_photo, v_file, p_user, p_user, 40, 30);
    insert into private.photo_album_items (album_id, photo_id, added_by) values (p_album, v_photo, p_user);
    return v_photo;
  end
  $$;

create function tests.cd_recipe(p_user uuid, p_home uuid, p_name text, p_cover uuid) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into private.recipes (id, owner_user_id, owner_home_id, status, name, name_key,
                                 cover_file_id, created_by, published_at)
      values (v_id, case when p_home is null then p_user end, p_home, 'published', p_name,
              lower(p_name), p_cover, p_user, now());
    insert into private.recipe_ingredients (recipe_id, position, name, name_key)
      values (v_id, 1, 'Flour', 'flour');
    insert into private.recipe_steps (recipe_id, position, body) values (v_id, 1, 'Mix.');
    return v_id;
  end
  $$;

create function tests.cd_event(p_user uuid, p_title text) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into private.calendar_events (id, owner_user_id, title, all_day, starts_on, ends_on,
                                         timezone, reminder_minutes, created_by)
      values (v_id, p_user, p_title, true, current_date, current_date, 'Europe/Brussels', 15, p_user);
    return v_id;
  end
  $$;

-- The outcome of one Home in a request_home_copies answer.
create function tests.cd_outcome(p_answer jsonb, p_home uuid) returns text
  language sql
  as $$
    select h ->> 'outcome' from jsonb_array_elements(p_answer -> 'homes') h
    where (h ->> 'homeId')::uuid = p_home
  $$;

create function tests.cd_request(p_answer jsonb, p_home uuid) returns uuid
  language sql
  as $$
    select (h ->> 'requestId')::uuid from jsonb_array_elements(p_answer -> 'homes') h
    where (h ->> 'homeId')::uuid = p_home
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select, insert on ids to authenticated, service_role;
create temporary table answers (name text primary key, value jsonb not null) on commit drop;
grant select, insert on answers to authenticated, service_role;

insert into ids values
  ('ola', tests.cd_account('ola-copies@madeora.test')),
  ('ana', tests.cd_account('ana-copies@madeora.test')),
  ('ben', tests.cd_account('ben-copies@madeora.test')),
  ('cleo', tests.cd_account('cleo-copies@madeora.test')),
  ('oak', gen_random_uuid()),
  ('birch', gen_random_uuid());

-- Ola owns Oak (Ana and Ben members, Cleo an Administrator without capabilities) and Birch (Ana).
insert into public.homes (id, name, timezone, creation_request_id) values
  ((select id from ids where name = 'oak'), 'Oak', 'Europe/Brussels', gen_random_uuid()),
  ((select id from ids where name = 'birch'), 'Birch', 'Europe/Brussels', gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'oak'), (select id from ids where name = 'ola'), 'owner'),
  ((select id from ids where name = 'oak'), (select id from ids where name = 'ana'), 'member'),
  ((select id from ids where name = 'oak'), (select id from ids where name = 'ben'), 'member'),
  ((select id from ids where name = 'oak'), (select id from ids where name = 'cleo'), 'administrator'),
  ((select id from ids where name = 'birch'), (select id from ids where name = 'ola'), 'owner'),
  ((select id from ids where name = 'birch'), (select id from ids where name = 'ana'), 'member');

-- Ana's personal data: a recipe with a cover shared into Oak, a plain recipe, an event shared into
-- Oak, an album with two of her photos and one of Ben's (contributed), a task list with a task,
-- a shopping list, a habit, a goal, a reward, a meal slot and entry.
insert into ids values ('cover', tests.cd_file((select id from ids where name = 'ana'), null, 'recipe_cover', 500));
insert into ids values
  ('pie', tests.cd_recipe((select id from ids where name = 'ana'), null, 'Pie', (select id from ids where name = 'cover'))),
  ('soup', tests.cd_recipe((select id from ids where name = 'ana'), null, 'Soup', null)),
  ('oak_recipe', tests.cd_recipe((select id from ids where name = 'ola'), (select id from ids where name = 'oak'), 'Stew', null)),
  ('ben_recipe', tests.cd_recipe((select id from ids where name = 'ben'), null, 'Salad', null)),
  ('cleo_recipe', tests.cd_recipe((select id from ids where name = 'cleo'), null, 'Bread', null)),
  ('party', tests.cd_event((select id from ids where name = 'ana'), 'Party')),
  ('album', gen_random_uuid()),
  ('list', gen_random_uuid()),
  ('slot', gen_random_uuid());
insert into private.recipe_shares (recipe_id, home_id, shared_by)
  values ((select id from ids where name = 'pie'), (select id from ids where name = 'oak'), (select id from ids where name = 'ana'));
insert into private.calendar_event_shares (event_id, home_id, user_id)
  values ((select id from ids where name = 'party'), (select id from ids where name = 'oak'), (select id from ids where name = 'ana'));
insert into private.photo_albums (id, owner_user_id, created_by, name)
  values ((select id from ids where name = 'album'), (select id from ids where name = 'ana'), (select id from ids where name = 'ana'), 'Summer');
insert into ids values
  ('photo1', tests.cd_photo((select id from ids where name = 'ana'), (select id from ids where name = 'album'))),
  ('photo2', tests.cd_photo((select id from ids where name = 'ana'), (select id from ids where name = 'album'))),
  ('ben_photo', tests.cd_photo((select id from ids where name = 'ben'), (select id from ids where name = 'album')));
insert into private.task_lists (id, owner_user_id, name)
  values ((select id from ids where name = 'list'), (select id from ids where name = 'ana'), 'Mine');
insert into private.tasks (id, owner_user_id, list_id, title)
  values (gen_random_uuid(), (select id from ids where name = 'ana'), (select id from ids where name = 'list'), 'Call mum');
insert into private.shopping_lists (id, owner_user_id, name)
  values (gen_random_uuid(), (select id from ids where name = 'ana'), 'Groceries');
insert into private.habits (id, owner_user_id, name, week_start, time_zone)
  values (gen_random_uuid(), (select id from ids where name = 'ana'), 'Run', 'monday', 'Europe/Brussels');
insert into private.personal_point_accounts (user_id) values ((select id from ids where name = 'ana'));
insert into private.personal_rewards (user_id, id, name, cost)
  values ((select id from ids where name = 'ana'), gen_random_uuid(), 'Cake', 10);
insert into private.meal_slots (id, owner_user_id, name)
  values ((select id from ids where name = 'slot'), (select id from ids where name = 'ana'), 'Lunch');
insert into private.meal_entries (id, owner_user_id, on_date, slot_id, is_recipe, recipe_id)
  values (gen_random_uuid(), (select id from ids where name = 'ana'), current_date,
          (select id from ids where name = 'slot'), true, (select id from ids where name = 'pie'));

select tests.ensure_session((select id from ids where name = id_name)) from (values ('ola'), ('ana'), ('ben'), ('cleo')) v(id_name);

-- ==================================================================================================
-- Part B: copies
-- ==================================================================================================

-- Where Ana could copy her things -----------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_true(
  (select d -> 'homes' @> jsonb_build_array(
      jsonb_build_object('homeId', (select id from ids where name = 'oak'), 'mode', 'approval', 'shared', true),
      jsonb_build_object('homeId', (select id from ids where name = 'birch'), 'mode', 'approval', 'shared', false))
     and (d ->> 'files')::int = 1 and d ->> 'label' = 'Pie'
   from public.list_copy_destinations('recipe', (select id from ids where name = 'pie')) d),
  'a plain member copies a recipe into her Homes only after approval, and sees where it is shared');
select tests.assert_true(
  (select i @> jsonb_build_array(jsonb_build_object('itemType', 'recipe',
      'itemId', (select id from ids where name = 'pie'), 'label', 'Pie', 'homes', jsonb_build_array('Oak')))
   from public.my_shared_copyable_items() i),
  'the Delete account page lists her items shared with a Home, with those Homes');
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_true(
  not exists (select 1 from jsonb_array_elements(public.my_shared_copyable_items()) e
              where e ->> 'itemId' = (select id from ids where name = 'pie')::text),
  'nobody else sees them');
select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_true(
  (select d -> 'homes' @> jsonb_build_array(jsonb_build_object(
      'homeId', (select id from ids where name = 'oak'), 'mode', 'direct'))
   from public.list_copy_destinations('calendar_event', (select id from ids where name = 'party')) d),
  'a member who may add Home events copies an event directly');
select tests.assert_denied(
  $q$select public.list_copy_destinations('recipe', (select id from ids where name = 'ben_recipe'))$q$,
  'someone else''s recipe cannot be copied (as if it did not exist)', 'P0002');
select tests.assert_denied(
  $q$select public.list_copy_destinations('recipe', (select id from ids where name = 'oak_recipe'))$q$,
  'a Home recipe is not a personal item', 'P0002');
select tests.assert_denied(
  $q$select public.list_copy_destinations('task', (select id from ids where name = 'pie'))$q$,
  'only recipes, events and albums are eligible', '22023');

-- A direct copy without files ----------------------------------------------------------------------

insert into answers select 'event', public.request_home_copies('calendar_event',
  (select id from ids where name = 'party'), array[(select id from ids where name = 'oak')]);
select tests.assert_true(
  tests.cd_outcome((select value from answers where name = 'event'), (select id from ids where name = 'oak')) = 'completed',
  'a direct copy without files is made at once');
select tests.act_as_owner();
insert into ids select 'event_copy', r.copy_id from private.home_copy_requests r
  where r.item_type = 'calendar_event' and r.status = 'completed';
select tests.assert_true(
  (select e.home_id = (select id from ids where name = 'oak') and e.owner_user_id is null
     and e.title = 'Party' and e.copied_from_personal_at is not null and e.reminder_minutes is null
     and e.created_by = (select id from ids where name = 'ana')
   from private.calendar_events e where e.id = (select id from ids where name = 'event_copy')),
  'the copy is an independent Home event with the origin date and no reminder');
select tests.assert_true(
  exists (select 1 from private.calendar_events e
          where e.id = (select id from ids where name = 'party') and e.owner_user_id = (select id from ids where name = 'ana')),
  'the personal original stays');
select tests.assert_true(
  not exists (select 1 from private.calendar_event_shares s where s.event_id = (select id from ids where name = 'party')),
  'the destination Home leaves the original''s share list');
select tests.assert_true(
  exists (select 1 from private.audit_events a where a.action = 'copy_request.completed'
          and a.home_id = (select id from ids where name = 'oak')),
  'the copy is audited in the Home (ids only)');

select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_true(
  public.get_copy_origin('calendar_event', (select id from ids where name = 'event_copy')) is not null,
  'members of the Home see when it was copied from personal');
select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_true(
  public.get_copy_origin('calendar_event', (select id from ids where name = 'party')) is null,
  'a personal item has no origin label');

-- Requests waiting for approval ------------------------------------------------------------------

insert into answers select 'pie', public.request_home_copies('recipe',
  (select id from ids where name = 'pie'),
  array[(select id from ids where name = 'oak'), (select id from ids where name = 'birch')]);
select tests.assert_true(
  tests.cd_outcome((select value from answers where name = 'pie'), (select id from ids where name = 'oak')) = 'pending'
  and tests.cd_outcome((select value from answers where name = 'pie'), (select id from ids where name = 'birch')) = 'pending',
  'each Home without the right waits for its own approval');
insert into ids values
  ('pie_oak', tests.cd_request((select value from answers where name = 'pie'), (select id from ids where name = 'oak'))),
  ('pie_birch', tests.cd_request((select value from answers where name = 'pie'), (select id from ids where name = 'birch')));
select tests.assert_true(
  tests.cd_outcome(public.request_home_copies('recipe', (select id from ids where name = 'pie'),
    array[(select id from ids where name = 'oak')]), (select id from ids where name = 'oak')) = 'already_open',
  'one open request per item and Home');

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 3 and bool_and(n.category = 'approvals' and n.show_in_app)
   from public.notifications n where n.kind = 'home_copy.approval_requested'),
  'approvers are notified in-app: Ola twice, Cleo once');
-- Email follows each approver's Approvals email setting (off until they switch it on).
insert into public.notification_preferences (user_id, home_id, category, channel, enabled)
  values ((select id from ids where name = 'cleo'), null, 'approvals', 'email', true);
select tests.assert_true(
  not exists (select 1 from public.notifications n where n.kind = 'home_copy.approval_requested'
              and n.user_id in ((select id from ids where name = 'ana'), (select id from ids where name = 'ben'))),
  'neither the requester nor a member without approval rights is notified');
select tests.assert_true(
  (select bool_and(not (n.params ? 'label') and not (n.params::text like '%Pie%'))
   from public.notifications n where n.kind = 'home_copy.approval_requested'),
  'notices never carry the item''s title');
select tests.assert_true(
  not exists (select 1 from private.recipes r where r.owner_home_id = (select id from ids where name = 'oak')
              and r.copied_from_personal_at is not null),
  'nothing is copied before approval');

select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_true(
  (select jsonb_array_length(q -> 'requests') = 0
   from public.list_home_copy_requests((select id from ids where name = 'oak')) q),
  'a plain member does not see recipe requests (she may not add Home recipes)');
select tests.assert_denied(
  $q$select public.decide_home_copy((select id from ids where name = 'pie_oak'), true)$q$,
  'and cannot decide one', 'P0002');
select tests.act_as_user((select id from ids where name = 'ola'));
select tests.assert_denied(
  $q$select public.cancel_home_copy((select id from ids where name = 'pie_oak'))$q$,
  'only the requester cancels', 'P0002');

select tests.act_as_user((select id from ids where name = 'cleo'));
select tests.assert_true(
  (select (q ->> 'canApprove')::boolean and jsonb_array_length(q -> 'requests') = 1
     and q -> 'requests' -> 0 ->> 'label' = 'Pie' and (q -> 'requests' -> 0 ->> 'files')::int = 1
   from public.list_home_copy_requests((select id from ids where name = 'oak')) q),
  'an Administrator reviews the request with the item''s title after a fresh check');
select tests.assert_denied(
  $q$select public.list_home_copy_requests((select id from ids where name = 'birch'))$q$,
  'nothing about a Home she is not in', '42501');

-- Approval with a file: reserved, copied by the job, then made -------------------------------------

select tests.assert_true(
  public.decide_home_copy((select id from ids where name = 'pie_oak'), true) = 'copying',
  'an Administrator approves; the cover is copied first');
select tests.act_as_owner();
select tests.assert_true(
  (select f.status = 'pending' and f.object_key like 'h/%' and f.declared_size = 500
     and p.owner_home_id = (select id from ids where name = 'oak')
   from private.home_copy_files c join private.stored_files f on f.id = c.dest_file_id
   join private.storage_pools p on p.id = f.pool_id
   where c.request_id = (select id from ids where name = 'pie_oak')),
  'a new Home file is reserved in Oak''s storage under a new key');
select tests.assert_true(
  exists (select 1 from private.job_outbox o where o.job_name = 'home-copy-files'
          and o.payload = jsonb_build_object('requestId', (select id from ids where name = 'pie_oak'))),
  'the copy job is queued with the request id only');
select tests.assert_true(
  not exists (select 1 from private.recipes r where r.owner_home_id = (select id from ids where name = 'oak')
              and r.copied_from_personal_at is not null),
  'the recipe does not appear before its cover is in place');

-- The approver's authority is checked again when the copy is made.
savepoint demoted;
update private.home_memberships_all set role = 'member'
  where home_id = (select id from ids where name = 'oak') and user_id = (select id from ids where name = 'cleo');
select tests.act_as_service_role();
select tests.assert_true(
  public.finish_home_copy_files((select id from ids where name = 'pie_oak'), true, null) = 'invalidated',
  'an approver who lost the right before the copy was made invalidates it');
select tests.act_as_owner();
select tests.assert_true(
  (select r.status = 'invalidated' and r.end_code = 'not_authorized' from private.home_copy_requests r
   where r.id = (select id from ids where name = 'pie_oak'))
  and not exists (select 1 from private.recipes r where r.owner_home_id = (select id from ids where name = 'oak')
                  and r.copied_from_personal_at is not null),
  'nothing is created and the request records why');
rollback to savepoint demoted;
select tests.act_as_owner();

insert into answers select 'cover_key', to_jsonb(f.object_key) from private.stored_files f
  where f.id = (select id from ids where name = 'cover');
select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_denied(
  $q$select public.begin_home_copy_files((select id from ids where name = 'pie_oak'))$q$,
  'only the job reads what to copy', '42501');
select tests.act_as_service_role();
select tests.assert_true(
  (select b ->> 'outcome' = 'ok' and jsonb_array_length(b -> 'objects') = 1
     and b -> 'objects' -> 0 ->> 'from' = (select value #>> '{}' from answers where name = 'cover_key')
     and (b -> 'objects' -> 0 ->> 'size')::int = 500
   from public.begin_home_copy_files((select id from ids where name = 'pie_oak')) b),
  'the job gets the source and destination keys with the expected size');
select tests.assert_true(
  public.finish_home_copy_files((select id from ids where name = 'pie_oak'), true) = 'completed',
  'once the objects are copied the copy is made');
select tests.act_as_owner();
insert into ids select 'pie_copy', r.copy_id from private.home_copy_requests r
  where r.id = (select id from ids where name = 'pie_oak');
select tests.assert_true(
  (select r.owner_home_id = (select id from ids where name = 'oak') and r.status = 'published'
     and r.cover_file_id <> (select id from ids where name = 'cover') and f.status = 'ready'
     and f.sha256 = repeat('c', 64) and f.size_bytes = 500
     and (select count(*) from private.recipe_ingredients i where i.recipe_id = r.id) = 1
     and (select count(*) from private.recipe_steps s where s.recipe_id = r.id) = 1
   from private.recipes r join private.stored_files f on f.id = r.cover_file_id
   where r.id = (select id from ids where name = 'pie_copy')),
  'the Home recipe has its own ready cover, ingredients and steps');
select tests.assert_true(
  not exists (select 1 from private.recipe_shares s where s.recipe_id = (select id from ids where name = 'pie')
              and s.home_id = (select id from ids where name = 'oak')),
  'Oak no longer sees the original through the share');
select tests.assert_true(
  exists (select 1 from public.notifications n where n.kind = 'home_copy.completed'
          and n.user_id = (select id from ids where name = 'ana')),
  'the requester is told the copy is ready');
select tests.assert_true(
  (select a.details ->> 'approvedBy' = (select id from ids where name = 'cleo')::text
     and a.details ->> 'requestedBy' = (select id from ids where name = 'ana')::text
   from private.audit_events a where a.action = 'copy_request.completed' and a.subject_id = (select id from ids where name = 'pie_oak')),
  'the audit records who asked and who approved');

-- Rejection, self-approval, cancel, expiry ---------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ola'));
select tests.assert_true(
  public.decide_home_copy((select id from ids where name = 'pie_birch'), false) = 'rejected',
  'the Owner rejects the Birch request');
select tests.assert_true(
  public.decide_home_copy((select id from ids where name = 'pie_birch'), true) = 'not_pending',
  'a decided request cannot be decided again');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from public.notifications n where n.kind = 'home_copy.rejected'
          and n.user_id = (select id from ids where name = 'ana')),
  'the requester is told it was rejected');

select tests.act_as_user((select id from ids where name = 'cleo'));
insert into answers select 'bread', public.request_home_copies('recipe',
  (select id from ids where name = 'cleo_recipe'), array[(select id from ids where name = 'oak')]);
select tests.assert_true(
  tests.cd_outcome((select value from answers where name = 'bread'), (select id from ids where name = 'oak')) = 'pending',
  'an Administrator without the recipe right waits for approval too');
select tests.assert_true(
  public.decide_home_copy(tests.cd_request((select value from answers where name = 'bread'),
    (select id from ids where name = 'oak')), true) = 'completed',
  'and may approve her own request');
select tests.act_as_owner();
select tests.assert_true(
  (select (a.details ->> 'selfApproved')::boolean from private.audit_events a
   where a.action = 'copy_request.approved'
     and a.subject_id = tests.cd_request((select value from answers where name = 'bread'), (select id from ids where name = 'oak'))),
  'self-approval is recorded as such');

select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'soup', public.request_home_copies('recipe',
  (select id from ids where name = 'soup'),
  array[(select id from ids where name = 'oak'), (select id from ids where name = 'birch')]);
select tests.assert_true(
  public.cancel_home_copy(tests.cd_request((select value from answers where name = 'soup'), (select id from ids where name = 'oak'))),
  'the requester cancels a pending request');
select tests.assert_true(
  not public.cancel_home_copy(tests.cd_request((select value from answers where name = 'soup'), (select id from ids where name = 'oak'))),
  'cancelling twice changes nothing');
select tests.act_as_owner();
update private.home_copy_requests set expires_at = now() - interval '1 second'
  where id = tests.cd_request((select value from answers where name = 'soup'), (select id from ids where name = 'birch'));
select tests.act_as_user((select id from ids where name = 'ola'));
select tests.assert_true(
  public.decide_home_copy(tests.cd_request((select value from answers where name = 'soup'),
    (select id from ids where name = 'birch')), true) = 'expired',
  'an expired request cannot be approved');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.recipes r where r.owner_home_id = (select id from ids where name = 'birch')),
  'expired and cancelled requests create nothing');

-- Rechecks: leaving the Home, the item going to the trash, the sweep ------------------------------

select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'soup2', public.request_home_copies('recipe',
  (select id from ids where name = 'soup'),
  array[(select id from ids where name = 'oak'), (select id from ids where name = 'birch')]);
select tests.act_as_owner();
delete from private.home_memberships_all
  where home_id = (select id from ids where name = 'birch') and user_id = (select id from ids where name = 'ana');
select tests.assert_true(
  (select r.status = 'invalidated' and r.end_code = 'not_member' from private.home_copy_requests r
   where r.id = tests.cd_request((select value from answers where name = 'soup2'), (select id from ids where name = 'birch'))),
  'leaving the Home ends the request there');
update private.recipes set deleted_at = now() where id = (select id from ids where name = 'soup');
select tests.assert_true(
  (select r.status = 'invalidated' and r.end_code = 'item_trashed' from private.home_copy_requests r
   where r.id = tests.cd_request((select value from answers where name = 'soup2'), (select id from ids where name = 'oak'))),
  'moving the item to the trash ends its requests');
update private.recipes set deleted_at = null where id = (select id from ids where name = 'soup');
insert into public.home_memberships (home_id, user_id, role)
  values ((select id from ids where name = 'birch'), (select id from ids where name = 'ana'), 'member');

select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'soup3', public.request_home_copies('recipe',
  (select id from ids where name = 'soup'), array[(select id from ids where name = 'birch')]);
select tests.act_as_owner();
update private.home_copy_requests set expires_at = now() - interval '1 second'
  where id = tests.cd_request((select value from answers where name = 'soup3'), (select id from ids where name = 'birch'));
select tests.act_as_service_role();
select tests.assert_true(public.sweep_home_copies(50) = 1, 'the hourly sweep expires a request past its 30 days');
select tests.act_as_owner();
select tests.assert_true(
  (select r.status = 'expired' from private.home_copy_requests r
   where r.id = tests.cd_request((select value from answers where name = 'soup3'), (select id from ids where name = 'birch'))),
  'and records it as expired');

-- An album: only her own photos, each with its variants; storage full; a failed copy ---------------

select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'album', public.request_home_copies('photo_album',
  (select id from ids where name = 'album'), array[(select id from ids where name = 'oak')]);
select tests.assert_true(
  tests.cd_outcome((select value from answers where name = 'album'), (select id from ids where name = 'oak')) = 'copying',
  'every member may add albums: the copy starts directly');
select tests.act_as_service_role();
select tests.assert_true(
  (select jsonb_array_length(b -> 'objects') = 8
   from public.begin_home_copy_files(tests.cd_request((select value from answers where name = 'album'), (select id from ids where name = 'oak'))) b),
  'two of her photos, each with three variants; Ben''s photo is not copied');
select tests.assert_true(
  public.finish_home_copy_files(tests.cd_request((select value from answers where name = 'album'),
    (select id from ids where name = 'oak')), true) = 'completed',
  'the album copy is made');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 and bool_and(p.owner_home_id = (select id from ids where name = 'oak')
     and p.copied_from_personal_at is not null and p.width = 40)
   from private.photo_album_items i join private.photos p on p.id = i.photo_id
   join private.photo_albums a on a.id = i.album_id
   where a.owner_home_id = (select id from ids where name = 'oak') and a.name = 'Summer'),
  'the Home album holds its own two photos');
select tests.assert_true(
  (select count(*) = 6 and bool_and(v.size_bytes = 100 and v.object_key like 'h/%')
   from private.photo_variants v join private.photos p on p.file_id = v.file_id
   where p.owner_home_id = (select id from ids where name = 'oak')),
  'with their own variants');

select private.lock_storage_pool(null, (select id from ids where name = 'birch'));
update private.storage_pools set allowance_bytes = 10 where owner_home_id = (select id from ids where name = 'birch');
select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_true(
  (select tests.cd_outcome(a, (select id from ids where name = 'birch')) = 'failed'
     and a -> 'homes' -> 0 ->> 'code' = 'storage_full'
   from public.request_home_copies('photo_album', (select id from ids where name = 'album'),
     array[(select id from ids where name = 'birch')]) a),
  'a Home without room refuses the copy with a clear code');

select tests.act_as_owner();
update private.storage_pools set allowance_bytes = null where owner_home_id = (select id from ids where name = 'birch');
select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'album2', public.request_home_copies('photo_album',
  (select id from ids where name = 'album'), array[(select id from ids where name = 'birch')]);
select tests.act_as_service_role();
select tests.assert_true(
  public.finish_home_copy_files(tests.cd_request((select value from answers where name = 'album2'),
    (select id from ids where name = 'birch')), false, 'source_missing') = 'failed',
  'a failed object copy fails the request');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.stored_files f join private.storage_pools p on p.id = f.pool_id
              where p.owner_home_id = (select id from ids where name = 'birch'))
  and not exists (select 1 from private.photo_albums a where a.owner_home_id = (select id from ids where name = 'birch')),
  'its reserved files are removed and nothing appears');
select tests.assert_true(
  (select count(*) >= 8 from private.storage_object_deletions d where d.object_key like 'h/%'),
  'the copied objects are queued for removal');
select tests.assert_true(
  exists (select 1 from public.notifications n where n.kind = 'home_copy.failed'
          and n.user_id = (select id from ids where name = 'ana')),
  'the requester is told it failed');

select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'album3', public.request_home_copies('photo_album',
  (select id from ids where name = 'album'), array[(select id from ids where name = 'birch')]);
select tests.act_as_owner();
update private.home_copy_requests set requested_at = now() - interval '7 hours'
  where id = tests.cd_request((select value from answers where name = 'album3'), (select id from ids where name = 'birch'));
select tests.act_as_service_role();
select tests.assert_true(public.sweep_home_copies(50) = 1, 'the hourly sweep ends a copy whose job died');
select tests.act_as_owner();
select tests.assert_true(
  (select r.status = 'failed' and r.end_code = 'copy_timeout' from private.home_copy_requests r
   where r.id = tests.cd_request((select value from answers where name = 'album3'), (select id from ids where name = 'birch')))
  and (select count(*) = 2 from public.notifications n where n.kind = 'home_copy.failed'
       and n.user_id = (select id from ids where name = 'ana')),
  'as failed with copy_timeout, and the requester is told');

-- Account deletion: pending requests first --------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'gate', public.request_home_copies('recipe',
  (select id from ids where name = 'soup'), array[(select id from ids where name = 'oak')]);
select tests.assert_true(
  (select jsonb_array_length(o) = 1 and o -> 0 ->> 'label' = 'Soup' from public.my_open_home_copies() o),
  'the Delete account page lists the open request');
select tests.act_as_owner();
select tests.cd_grant((select id from ids where name = 'ana'), 'delete_account');
insert into answers select 'notices', to_jsonb(count(*)) from public.notifications;
select tests.assert_true(
  (select n.email_status in ('queued', 'skipped') from public.notifications n
   where n.kind = 'home_copy.approval_requested' and n.user_id = (select id from ids where name = 'cleo')
     and n.params ->> 'requestId' = tests.cd_request((select value from answers where name = 'gate'),
       (select id from ids where name = 'oak'))::text),
  'an approver who wants approval emails gets one');
select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_denied($q$select public.request_account_deletion()$q$,
  'account deletion waits until pending requests are cancelled', 'P0001');
select tests.assert_true(public.cancel_my_pending_home_copies() = 1, 'cancelling them all at once');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from public.notifications) = (select (value #>> '{}')::bigint from answers where name = 'notices'),
  'nobody else is told');

-- ==================================================================================================
-- Part A: category deletion
-- ==================================================================================================

select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_denied(
  $q$select public.personal_deletion_preview(array['account'])$q$,
  'account data is not a deletable category here', '22023');
select tests.assert_true(
  (select (p -> 'categories' -> 'recipes' ->> 'items')::int = 2
     and (p -> 'categories' -> 'recipes' ->> 'files')::int = 1
     and (p -> 'categories' -> 'media' ->> 'items')::int = 3
     and (p -> 'categories' -> 'calendar' ->> 'items')::int = 1
     and not (p -> 'categories' ? 'tasks')
   from public.personal_deletion_preview(array['recipes', 'media', 'calendar']) p),
  'the preview counts her own items per chosen category');

select tests.assert_denied(
  $q$select public.delete_personal_data('00000000-0000-4000-8000-000000000001', array['recipes'])$q$,
  'deleting needs a fresh re-authentication', '42501');

-- An open personal export and a pending copy request that the deletion ends.
select tests.act_as_owner();
insert into private.data_exports (requester_id, kind, categories, all_data, status)
  values ((select id from ids where name = 'ana'), 'personal', array['recipes'], false, 'preparing');
select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'last', public.request_home_copies('recipe',
  (select id from ids where name = 'soup'), array[(select id from ids where name = 'oak')]);

-- One category fails (a test trigger refuses shopping deletes): the others still go.
select tests.act_as_owner();
create function tests.cd_refuse() returns trigger language plpgsql as $$
  begin raise exception 'refused for the test'; end $$;
create trigger cd_refuse before delete on private.shopping_lists
  for each row execute function tests.cd_refuse();
insert into ids select 'cover_key_owner', (select id from ids where name = 'ana');
select tests.cd_grant((select id from ids where name = 'ana'), 'delete_personal_data');
select tests.act_as_user((select id from ids where name = 'ana'));
insert into answers select 'deleted', public.delete_personal_data('00000000-0000-4000-8000-000000000001',
  array['media', 'recipes', 'calendar', 'shopping', 'recipes']);
select tests.assert_true(
  (select a ->> 'status' = 'partial'
     and a -> 'results' -> 'recipes' = '{"outcome": "deleted", "count": 2}'::jsonb
     and a -> 'results' -> 'media' = '{"outcome": "deleted", "count": 3}'::jsonb
     and a -> 'results' -> 'calendar' = '{"outcome": "deleted", "count": 1}'::jsonb
     and a -> 'results' -> 'shopping' ->> 'outcome' = 'failed'
   from (select value a from answers where name = 'deleted') x),
  'each category reports its own result; a failure makes the request partial');

select tests.act_as_owner();
drop trigger cd_refuse on private.shopping_lists;
select tests.assert_true(
  not exists (select 1 from private.recipes r where r.owner_user_id = (select id from ids where name = 'ana'))
  and not exists (select 1 from private.photos p where p.owner_user_id = (select id from ids where name = 'ana'))
  and not exists (select 1 from private.photo_albums a where a.owner_user_id = (select id from ids where name = 'ana'))
  and not exists (select 1 from private.calendar_events e where e.owner_user_id = (select id from ids where name = 'ana')),
  'her recipes, photos, albums and events are gone, also those in the trash');
select tests.assert_true(
  exists (select 1 from private.shopping_lists l where l.owner_user_id = (select id from ids where name = 'ana'))
  and exists (select 1 from private.tasks t where t.owner_user_id = (select id from ids where name = 'ana'))
  and exists (select 1 from private.habits h where h.owner_user_id = (select id from ids where name = 'ana')),
  'the failed category and the categories not chosen stay');
select tests.assert_true(
  not exists (select 1 from private.stored_files f where f.id = (select id from ids where name = 'cover'))
  and (select count(*) = 0 from private.stored_files f join private.storage_pools p on p.id = f.pool_id
       where p.owner_user_id = (select id from ids where name = 'ana') and f.purpose in ('photo', 'recipe_cover')),
  'her cover and photo files are deleted');
select tests.assert_true(
  (select count(*) >= 9 from private.storage_object_deletions d where d.object_key like 'u/%'),
  'and their objects (with photo variants) are queued for removal');
select tests.assert_true(
  exists (select 1 from private.photos p where p.id = (select id from ids where name = 'ben_photo'))
  and exists (select 1 from private.recipes r where r.id = (select id from ids where name = 'ben_recipe'))
  and exists (select 1 from private.recipes r where r.id = (select id from ids where name = 'oak_recipe')),
  'other people''s items and Home recipes are untouched');
select tests.assert_true(
  exists (select 1 from private.recipes r where r.id = (select id from ids where name = 'pie_copy'))
  and exists (select 1 from private.calendar_events e where e.id = (select id from ids where name = 'event_copy'))
  and exists (select 1 from private.photo_albums a where a.owner_home_id = (select id from ids where name = 'oak')),
  'Home copies made earlier stay: they are independent');
select tests.assert_true(
  (select f.status = 'ready' from private.recipes r join private.stored_files f on f.id = r.cover_file_id
   where r.id = (select id from ids where name = 'pie_copy')),
  'including the copy''s own cover');
select tests.assert_true(
  (select count(*) = 3 from public.home_memberships m where m.user_id = (select id from ids where name = 'ana')) is not null
  and (select count(*) from private.home_memberships_all m where m.user_id = (select id from ids where name = 'ana')) = 2,
  'her memberships are unchanged');
select tests.assert_true(
  (select e.status = 'invalidated' from private.data_exports e
   where e.requester_id = (select id from ids where name = 'ana')),
  'her open personal export is invalidated');
select tests.assert_true(
  (select r.status = 'invalidated' and r.end_code = 'item_deleted' from private.home_copy_requests r
   where r.id = tests.cd_request((select value from answers where name = 'last'), (select id from ids where name = 'oak'))),
  'a pending copy request for a deleted item ends');
select tests.assert_true(
  exists (select 1 from private.meal_entries e where e.owner_user_id = (select id from ids where name = 'ana')
          and e.recipe_id is null),
  'a meal that used a deleted recipe stays (meals were not chosen) without the recipe');
select tests.assert_true(
  exists (select 1 from private.account_activity_events a where a.kind = 'personal_data_deleted'
          and a.user_id = (select id from ids where name = 'ana') and a.category = 'privacy'),
  'the deletion is in her activity history');

select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_true(
  (select a ->> 'status' = 'partial' from public.delete_personal_data('00000000-0000-4000-8000-000000000001',
     array['recipes', 'calendar', 'media', 'shopping']) a),
  'the same request id returns the stored result without asking for a new re-authentication');
select tests.assert_denied(
  $q$select public.delete_personal_data('00000000-0000-4000-8000-000000000001', array['tasks'])$q$,
  'a request id cannot be reused for other categories', '22023');

select tests.act_as_owner();
select tests.cd_grant((select id from ids where name = 'ana'), 'delete_personal_data');
select tests.act_as_user((select id from ids where name = 'ana'));
select tests.assert_true(
  (select a ->> 'status' = 'completed' and a -> 'results' -> 'meals' ->> 'outcome' = 'deleted'
     and a -> 'results' -> 'habits_goals' = '{"outcome": "deleted", "count": 2}'::jsonb
     and a -> 'results' -> 'tasks' = '{"outcome": "deleted", "count": 2}'::jsonb
   from public.delete_personal_data('00000000-0000-4000-8000-000000000002',
     array['tasks', 'shopping', 'meals', 'habits_goals']) a),
  'the remaining categories are deleted on a new request');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.shopping_lists l where l.owner_user_id = (select id from ids where name = 'ana'))
  and not exists (select 1 from private.tasks t where t.owner_user_id = (select id from ids where name = 'ana'))
  and not exists (select 1 from private.meal_slots s where s.owner_user_id = (select id from ids where name = 'ana'))
  and not exists (select 1 from private.personal_rewards r where r.user_id = (select id from ids where name = 'ana')),
  'tasks, shopping, meals, habits and rewards are gone');
select tests.assert_true(
  exists (select 1 from auth.users u where u.id = (select id from ids where name = 'ana')),
  'the account itself stays');

-- Other people cannot see or act on someone's deletion requests.
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_denied($q$select * from private.personal_data_deletions$q$,
  'deletion requests are not exposed', '42501');
select tests.assert_denied($q$select * from private.home_copy_requests$q$,
  'copy requests are not exposed', '42501');
