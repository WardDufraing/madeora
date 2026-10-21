-- S19c: task attachments (supabase/migrations/*_task_attachments_calendar_widgets.sql). Alice owns
-- Home A, where Carol is a Member; Bob owns Home B. Covers: tables unreachable; upload intents only
-- for tasks the caller may edit, into the task's own pool (Home or personal), with the type, size,
-- name and per-task limits (uploads in progress counted) and a full pool; attaching re-checks the
-- task and the caller's rights; retries never link twice; reading follows the task (members see,
-- other Homes, former members, removed attachments and deleted tasks do not; forged ids); removing
-- into the trash and restoring (with the limit conflict and the task in the trash); deleting and
-- restoring a task with its files; a file shared by two occurrences stays while one is deleted;
-- purging releases only files nothing refers to; series scopes (this / following / entire, completed
-- and individually changed occurrences kept, new occurrences inherit, series-wide removal and
-- restore, none from a completed occurrence, at most 10 per chain); a schedule change keeps an
-- occurrence with its own file; a finished upload nobody attached is retired by the expiry job.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Pacific/Auckland', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');

insert into ids select n, gen_random_uuid() from unnest(array[
  'l-a', 'l-b', 'l-p', 't-carol', 't-alice', 't-assigned', 't-p', 't-b', 't-full', 't-del', 's1'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.occ(p_root text, p_date date) returns uuid
  language sql stable security definer as $$
  select id from private.tasks where series_root_id = tests.i(p_root) and occurrence_date = p_date; $$;
create function tests.file_status(p_name text) returns text
  language sql stable security definer as $$
  select status from private.stored_files where id = tests.i(p_name); $$;
create function tests.links(p_task uuid) returns bigint
  language sql stable security definer as $$
  select count(*) from private.task_attachments where task_id = p_task and removed_at is null; $$;
create function tests.pool_owner(p_name text) returns text
  language sql stable security definer as $$
  select case when p.owner_home_id is not null then 'home:' || p.owner_home_id else 'user:' || p.owner_user_id end
  from private.stored_files f join private.storage_pools p on p.id = f.pool_id where f.id = tests.i(p_name); $$;

-- Opens an attachment upload as the current actor; records the file id under p_name when it opens.
create function tests.intent(
  p_name text, p_task uuid, p_type text default 'application/pdf', p_size bigint default 1000,
  p_file_name text default 'Receipt.pdf'
) returns text
  language plpgsql as $$
  declare
    v record;
  begin
    select * into v from public.create_task_attachment_intent(p_task, p_type, p_size, p_file_name,
      gen_random_uuid());
    if v.outcome = 'ok' then
      insert into ids values (p_name, v.file_id);
    end if;
    return v.outcome;
  end
  $$;

-- Finalizes as the server would (service role) for p_user, then acts as p_user again.
create function tests.finalize(p_user text, p_name text, p_type text default 'application/pdf',
  p_size bigint default 1000)
returns text
  language plpgsql as $$
  declare
    v_outcome text;
  begin
    perform tests.act_as_service_role();
    v_outcome := public.finalize_upload(tests.user_id(p_user), tests.i(p_name), p_type, p_size,
      encode(extensions.digest(p_name, 'sha256'), 'hex'));
    perform tests.act_as(p_user);
    return v_outcome;
  end
  $$;

-- Opens, finalizes and attaches in one go as p_user; returns the attachment id.
create function tests.attach(p_user text, p_name text, p_task uuid, p_scope text default 'this')
returns uuid
  language plpgsql as $$
  declare
    v record;
  begin
    perform tests.act_as(p_user);
    if tests.intent(p_name, p_task) <> 'ok' then
      raise exception 'intent for % failed', p_name;
    end if;
    if tests.finalize(p_user, p_name) <> 'ready' then
      raise exception 'finalize for % failed', p_name;
    end if;
    select * into v from public.attach_task_file(tests.i(p_name), p_scope);
    if v.outcome <> 'attached' then
      raise exception 'attach for % failed: %', p_name, v.outcome;
    end if;
    insert into ids values ('a:' || p_name, v.attachment_id);
    return v.attachment_id;
  end
  $$;

-- Fills a task with ready attachments up to p_count (setup only, as the owner).
create function tests.fill(p_task uuid, p_count integer) returns void
  language plpgsql security definer as $$
  declare
    v_task private.tasks;
    v_pool uuid;
    v_file uuid;
  begin
    select * into v_task from private.tasks where id = p_task;
    v_pool := (private.lock_storage_pool(v_task.owner_user_id, v_task.owner_home_id)).id;
    while tests.links(p_task) < p_count loop
      insert into private.stored_files (pool_id, purpose, created_by, request_id, upload_key, object_key,
        declared_type, declared_size, content_type, size_bytes, sha256, status, expires_at, finalized_at)
      values (v_pool, 'task_attachment', v_task.created_by, gen_random_uuid(), private.new_object_key('h'),
        private.new_object_key('h'), 'application/pdf', 10, 'application/pdf', 10, repeat('b', 64),
        'ready', now() + interval '15 minutes', now())
      returning id into v_file;
      insert into private.task_attachments (task_id, file_id, display_name, added_by)
        values (p_task, v_file, 'Filler.pdf', v_task.created_by);
    end loop;
  end
  $$;

grant execute on function tests.i(text), tests.today_a(), tests.occ(text, date), tests.file_status(text),
  tests.links(uuid), tests.pool_owner(text),
  tests.intent(text, uuid, text, bigint, text), tests.finalize(text, text, text, bigint),
  tests.attach(text, text, uuid, text), tests.fill(uuid, integer)
  to authenticated, service_role;

-- Nothing reachable --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.task_attachments', 'The API cannot read attachments');
select tests.assert_denied('select * from private.task_series_attachments',
  'The API cannot read series attachments');
select tests.assert_denied('select * from private.task_attachment_uploads', 'The API cannot read uploads');
select tests.act_as_anon();
select tests.assert_denied(
  $$select public.create_task_attachment_intent(gen_random_uuid(), 'application/pdf', 10, 'x.pdf', gen_random_uuid())$$,
  'Nobody signed out opens an upload');
select tests.assert_denied($$select public.list_task_attachments(gen_random_uuid())$$,
  'Nobody signed out lists attachments');
select tests.act_as('alice');
select tests.assert_denied($$select public.expire_upload(gen_random_uuid())$$,
  'Only the job runner expires uploads');

-- Setup --------------------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_task_list(tests.i('l-a'), 'Chores', tests.i('home-a'));
select public.create_task_list(tests.i('l-p'), 'Mine');
select public.create_task(tests.i('t-alice'), tests.i('l-a'), 'Alice''s', p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-assigned'), tests.i('l-a'), 'Assigned to Carol',
  p_assignee_ids => array[tests.i('m-carol-a')], p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-full'), tests.i('l-a'), 'Full', p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-p'), tests.i('l-p'), 'Personal');
select tests.act_as('carol');
select public.create_task(tests.i('t-carol'), tests.i('l-a'), 'Carol''s', p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-del'), tests.i('l-a'), 'Soon deleted', p_home_id => tests.i('home-a'));
select tests.act_as('bob');
select public.create_task_list(tests.i('l-b'), 'Kot', tests.i('home-b'));
select public.create_task(tests.i('t-b'), tests.i('l-b'), 'Bob''s', p_home_id => tests.i('home-b'));

-- Intents ------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.intent('f-carol', tests.i('t-carol')) = 'ok',
  'The creator opens an upload for their task');
select tests.assert_true(tests.pool_owner('f-carol') = 'home:' || tests.i('home-a'),
  'A Home task''s file goes to the Home''s pool');
select tests.assert_true(tests.intent('f-x', tests.i('t-alice')) = 'not_permitted',
  'A member who neither created nor is assigned to a task cannot upload to it');
select tests.assert_true(tests.intent('f-assigned', tests.i('t-assigned'), 'image/png', 2000, 'Photo.png') = 'ok',
  'An assignee uploads');
select tests.assert_true(tests.intent('f-x', tests.i('t-b')) = 'not_found',
  'Another Home''s task is not found');
select tests.assert_true(tests.intent('f-x', tests.i('t-p')) = 'not_found',
  'Someone else''s personal task is not found');
select tests.assert_denied(
  $$select tests.intent('f-x', tests.i('t-carol'), 'application/x-msdownload')$$,
  'An executable type is refused', '22023');
select tests.assert_denied(
  $$select tests.intent('f-x', tests.i('t-carol'), 'image/svg+xml')$$,
  'SVG (scriptable) is refused', '22023');
select tests.assert_denied(
  $$select tests.intent('f-x', tests.i('t-carol'), 'application/pdf', 10485761)$$,
  'More than 10 MB is refused', '22023');
select tests.assert_denied(
  $$select tests.intent('f-x', tests.i('t-carol'), 'application/pdf', 10, ' ')$$,
  'A blank name is refused', '22023');
select tests.assert_denied(
  $$select tests.intent('f-x', tests.i('t-carol'), 'application/pdf', 10, E'evil‮fdp.exe')$$,
  'A name with a direction override is refused', '22023');

select tests.act_as('alice');
select tests.assert_true(tests.intent('f-alice-carol', tests.i('t-carol')) = 'ok',
  'A task manager (the Owner) uploads to anyone''s Home task');
select tests.assert_true(tests.intent('f-p', tests.i('t-p'), 'text/plain', 50, 'notes.txt') = 'ok',
  'The owner uploads to a personal task');
select tests.assert_true(tests.pool_owner('f-p') = 'user:' || tests.user_id('alice'),
  'A personal task''s file goes to the person''s pool');

-- Retrying the same request id returns the same upload; a different upload under it conflicts.
do $$
declare
  v_request uuid := gen_random_uuid();
  v_first record;
  v_second record;
  v_other record;
begin
  perform tests.act_as('alice');
  select * into v_first from public.create_task_attachment_intent(tests.i('t-alice'), 'application/pdf', 99, 'a.pdf', v_request);
  select * into v_second from public.create_task_attachment_intent(tests.i('t-alice'), 'application/pdf', 99, 'a.pdf', v_request);
  select * into v_other from public.create_task_attachment_intent(tests.i('t-alice'), 'application/pdf', 98, 'a.pdf', v_request);
  perform tests.assert_true(v_first.outcome = 'ok' and v_second.outcome = 'ok' and v_first.file_id = v_second.file_id,
    'A retried intent is the same upload');
  perform tests.assert_true(v_other.outcome = 'conflict', 'A request id reused for another upload conflicts');
end
$$;

-- Ten per task, counting uploads in progress (under the task's lock).
select tests.fill(tests.i('t-full'), 9);
select tests.act_as('alice');
select tests.assert_true(tests.intent('f-full-10', tests.i('t-full')) = 'ok', 'The tenth place can be taken');
select tests.assert_true(tests.intent('f-full-11', tests.i('t-full')) = 'limit_reached',
  'An eleventh upload is refused while the tenth is in progress');

-- A full pool refuses new files.
select tests.act_as_service_role();
select public.set_storage_allowance(null, tests.i('home-a'), 100);
select tests.act_as('carol');
select tests.assert_true(tests.intent('f-x', tests.i('t-carol'), 'application/pdf', 5000) = 'storage_full',
  'A full Home pool refuses a new attachment');
select tests.act_as_service_role();
select public.set_storage_allowance(null, tests.i('home-a'), null);

-- Attaching -----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_found' from public.attach_task_file(tests.i('f-carol'))),
  'An upload that is not finished cannot be attached');
select tests.assert_true(tests.finalize('carol', 'f-carol') = 'ready', 'setup: finalized');
select tests.assert_true(
  (select outcome = 'attached' from public.attach_task_file(tests.i('f-carol'))),
  'The uploader attaches the finished file');
select tests.assert_true(
  (select outcome = 'attached' from public.attach_task_file(tests.i('f-carol'))) and tests.links(tests.i('t-carol')) = 1,
  'A retried attach links once');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_found' from public.attach_task_file(tests.i('f-carol'))),
  'Someone else''s upload cannot be attached');
select tests.act_as_owner();
insert into ids select 'a:f-carol', id from private.task_attachments where file_id = tests.i('f-carol');

-- Losing the right between intent and attach: Carol is unassigned meanwhile.
select tests.assert_true(tests.finalize('carol', 'f-assigned', 'image/png', 2000) = 'ready', 'setup: finalized');
select tests.act_as('alice');
select public.set_task_assignees(tests.i('t-assigned'), 1, '{}');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.attach_task_file(tests.i('f-assigned'))),
  'Attaching re-checks the right: an unassigned member is refused');
-- The expiry job retires the finished file nobody attached, so it does not count forever.
select tests.act_as_owner();
update private.stored_files set expires_at = now() - interval '1 minute' where id = tests.i('f-assigned');
select tests.act_as_service_role();
select tests.assert_true(public.expire_upload(tests.i('f-assigned')) = 'deleted',
  'An unattached finished upload is retired by the expiry job');
select tests.assert_true(public.expire_upload(tests.i('f-assigned')) = 'deleted', 'The job is idempotent');

-- Reading ---------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select jsonb_array_length(public.list_task_attachments(tests.i('t-carol')) -> 'attachments') = 1
     and (public.list_task_attachments(tests.i('t-carol')) ->> 'canAdd')::boolean),
  'A task manager sees the attachment and may add');
select tests.assert_true(
  (select (a ->> 'name') = 'Receipt.pdf' and (a ->> 'contentType') = 'application/pdf'
     and (a ->> 'size')::integer = 1000 and not (a ->> 'fromSeries')::boolean
     and (a -> 'addedBy' ->> 'member') = tests.i('m-carol-a')::text
   from jsonb_array_elements(public.list_task_attachments(tests.i('t-carol')) -> 'attachments') a),
  'Name, verified type and size, and who added it (by membership)');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-carol'))$$, 1,
  'A member reads a Home task''s attachment');
select tests.assert_true(
  (select display_name = 'Receipt.pdf' from public.authorize_file_read(tests.i('f-carol'))),
  'The read returns the display name for the download');
select tests.act_as('bob');
select tests.assert_true(public.list_task_attachments(tests.i('t-carol')) is null,
  'Another Home''s member does not see the task''s attachments');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-carol'))$$, 0,
  'Another Home''s member cannot read the file');
select tests.assert_row_count($$select * from public.authorize_file_read(gen_random_uuid())$$, 0,
  'A forged file id reads nothing');
select tests.act_as('carol');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-assigned'))$$, 0,
  'An unattached (retired) file reads nothing');

-- A viewer who may not edit sees the files but may not add or remove.
select tests.attach('alice', 'f-alice', tests.i('t-alice'));
select tests.act_as('carol');
select tests.assert_true(
  (select not (l ->> 'canAdd')::boolean and not (l -> 'attachments' -> 0 ->> 'canRemove')::boolean
   from public.list_task_attachments(tests.i('t-alice')) l),
  'A read-only viewer sees the attachment without add or remove');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-alice'))$$, 1,
  'A read-only viewer downloads');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.remove_task_attachment(tests.i('a:f-alice'))),
  'A read-only viewer cannot remove');

-- A personal task's file: its owner only.
select tests.act_as('alice');
select tests.assert_true(tests.finalize('alice', 'f-p', 'text/plain', 50) = 'ready', 'setup: finalized');
select public.attach_task_file(tests.i('f-p'));
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-p'))$$, 1,
  'The owner reads a personal attachment');
select tests.act_as('carol');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-p'))$$, 0,
  'Nobody else reads a personal attachment');

-- Removing and restoring ---------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'preview' from public.remove_task_attachment(tests.i('a:f-carol'), 'this', true))
    and tests.links(tests.i('t-carol')) = 1,
  'A dry run changes nothing');
insert into ids select 'e-carol', entry_id from public.remove_task_attachment(tests.i('a:f-carol'));
select tests.assert_true(tests.links(tests.i('t-carol')) = 0 and tests.file_status('f-carol') = 'deleted',
  'Removed into the trash; the file is in the file trash (still counted)');
select tests.assert_true(
  (select outcome = 'not_found' from public.remove_task_attachment(tests.i('a:f-carol'))),
  'Removing it again (a stale request) finds nothing');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-carol'))$$, 0,
  'A removed attachment cannot be read');
select tests.assert_true(
  exists (select 1 from public.list_trash(tests.i('home-a'), 'tasks', 'task_attachment')
    where label = 'Receipt.pdf'),
  'The person who removed it sees it in the Home trash under its name');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-carol')])),
  'Restored');
select tests.assert_true(tests.links(tests.i('t-carol')) = 1 and tests.file_status('f-carol') = 'ready',
  'The attachment and its file are back');

-- Restoring onto a task that has room no longer: the limit is a conflict.
insert into ids select 'e-carol-2', entry_id from public.remove_task_attachment(tests.i('a:f-carol'));
select tests.fill(tests.i('t-carol'), 10);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'attachment_limit'
   from public.restore_trash_entries(array[tests.i('e-carol-2')])),
  'A task already at ten attachments is a conflict');
select tests.act_as_owner();
delete from private.task_attachments where task_id = tests.i('t-carol') and display_name = 'Filler.pdf';
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-carol-2')])),
  'With room again, it is restored');

-- Deleting and restoring a task with its files.
select tests.attach('carol', 'f-del', tests.i('t-del'));
select tests.act_as('carol');
insert into ids select 'e-del', entry_id from public.delete_task(tests.i('t-del'));
select tests.assert_true(tests.file_status('f-del') = 'deleted',
  'Deleting the task takes its exclusive file into the trash');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-del'))$$, 0,
  'A deleted task''s file cannot be read');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_found' from public.remove_task_attachment(tests.i('a:f-del'))),
  'An attachment of a deleted task cannot be removed on its own');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'restored' and attachments_lost = 0 from public.restore_trash_entries(array[tests.i('e-del')])),
  'Restoring the task');
select tests.assert_true(tests.links(tests.i('t-del')) = 1 and tests.file_status('f-del') = 'ready',
  'The task comes back with its attachment');

-- An attachment removed, then its task deleted: restoring the attachment first is a conflict.
insert into ids select 'e-del-a', entry_id from public.remove_task_attachment(tests.i('a:f-del'));
insert into ids select 'e-del-t', entry_id from public.delete_task(tests.i('t-del'));
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'task_unavailable'
   from public.restore_trash_entries(array[tests.i('e-del-a')])),
  'The task in the trash must come back first');

-- Purging the task for good takes its removed attachments with it, and releases the file.
select tests.assert_true(
  (select outcome = 'purged' from public.purge_trash_entries(array[tests.i('e-del-t')])),
  'setup: the task purged');
select tests.assert_true(tests.file_status('f-del') = 'purged',
  'With no row left referring to it, the file is released');
select tests.assert_true(
  (select outcome = 'not_found' from public.restore_trash_entries(array[tests.i('e-del-a')])),
  'Its removed attachment can no longer come back');

-- Recurring tasks: scopes -------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_task_series(tests.i('s1'), tests.i('l-a'), 'Water plants', 'daily', 1, tests.today_a(),
  p_home_id => tests.i('home-a'));
select tests.assert_true(tests.occ('s1', tests.today_a()) is not null and tests.occ('s1', tests.today_a() + 1) is not null,
  'setup: today and tomorrow');
select public.set_task_completion(tests.occ('s1', tests.today_a()), true);

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.task_attachment_scope_impact(tests.occ('s1', tests.today_a() + 1), 'series')),
  'A member without the series right cannot change series attachments');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'changed')::integer = 1 and (impact ->> 'completed')::integer = 1
   from public.task_attachment_scope_impact(tests.occ('s1', tests.today_a() + 1), 'series')),
  'The impact: one open occurrence changes, the completed one is kept');
select tests.attach('alice', 'f-series', tests.occ('s1', tests.today_a() + 1), 'series');
select tests.assert_true(
  tests.links(tests.occ('s1', tests.today_a() + 1)) = 1 and tests.links(tests.occ('s1', tests.today_a())) = 0,
  'The open occurrence gets it; the completed one is untouched');
select tests.assert_true(
  (select (a ->> 'fromSeries')::boolean and (a ->> 'seriesActive')::boolean
   from jsonb_array_elements(public.list_task_attachments(tests.occ('s1', tests.today_a() + 1)) -> 'attachments') a),
  'It is marked as from the series');

-- New occurrences inherit it.
select tests.act_as_owner();
select private.create_occurrence((select s from private.task_series s where s.root_id = tests.i('s1')
  and s.superseded_at is null), tests.today_a() + 2);
select tests.assert_true(tests.links(tests.occ('s1', tests.today_a() + 2)) = 1,
  'A new occurrence starts with the series attachment');
select tests.assert_true(
  (select count(*) = 1 from private.stored_files where id = tests.i('f-series')),
  'Stored once, whatever the number of occurrences');

-- A file shared by occurrences stays while one of them is deleted.
select tests.act_as('alice');
insert into ids select 'e-occ', entry_id from public.delete_task(tests.occ('s1', tests.today_a() + 2));
select tests.assert_true(tests.file_status('f-series') = 'ready',
  'A file other active tasks still use is not moved to the trash');
select public.restore_trash_entries(array[tests.i('e-occ')]);

-- An occurrence-only attachment on a recurring task.
select tests.attach('alice', 'f-own', tests.occ('s1', tests.today_a() + 1), 'this');
select tests.assert_true(
  tests.links(tests.occ('s1', tests.today_a() + 1)) = 2 and tests.links(tests.occ('s1', tests.today_a() + 2)) = 1,
  'This occurrence only');

-- An individually changed occurrence is kept by a series-wide removal.
select tests.act_as_owner();
update private.tasks set detached = true where id = tests.occ('s1', tests.today_a() + 2);
insert into ids select 'a-series-1', id from private.task_attachments
  where file_id = tests.i('f-series') and task_id = tests.occ('s1', tests.today_a() + 1);
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'scope_unavailable'
   from public.remove_task_attachment(tests.i('a:f-own'), 'series', true)),
  'An occurrence''s own attachment has no series scope');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'changed')::integer = 1 and (impact ->> 'kept')::integer = 1
   from public.remove_task_attachment(tests.i('a-series-1'), 'following', true)),
  'The removal impact: one changes, the individually changed one is kept');
insert into ids select 'e-series', entry_id from public.remove_task_attachment(tests.i('a-series-1'), 'following');
select tests.assert_true(
  tests.links(tests.occ('s1', tests.today_a() + 1)) = 1 and tests.links(tests.occ('s1', tests.today_a() + 2)) = 1,
  'Removed from this occurrence on, the individually changed one keeps it');
select tests.assert_true(tests.file_status('f-series') = 'ready',
  'The file stays while an occurrence still uses it');
select tests.act_as_owner();
select private.create_occurrence((select s from private.task_series s where s.root_id = tests.i('s1')
  and s.superseded_at is null), tests.today_a() + 3);
select tests.assert_true(tests.links(tests.occ('s1', tests.today_a() + 3)) = 0,
  'New occurrences no longer get it');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-series')])),
  'The series-wide removal is restored as one');
select tests.act_as_owner();
select tests.assert_true(
  tests.links(tests.occ('s1', tests.today_a() + 1)) = 2
    and exists (select 1 from private.task_series_attachments where file_id = tests.i('f-series') and removed_at is null),
  'The series attachment and its occurrence link are back');

-- An occurrence with a file of its own is changed on its own: a schedule change keeps it (and the
-- file), rather than deleting it as untouched and purging the file without a trash entry.
insert into ids values ('s2', gen_random_uuid());
create function tests.rev(p_task uuid) returns integer
  language sql stable security definer as $$ select revision from private.tasks where id = p_task; $$;
create function tests.srev(p_root text) returns integer
  language sql stable security definer as $$
  select revision from private.task_series where root_id = tests.i(p_root) and superseded_at is null; $$;
grant execute on function tests.rev(uuid), tests.srev(text) to authenticated;
select tests.act_as('alice');
select public.create_task_series(tests.i('s2'), tests.i('l-a'), 'Feed the fish', 'daily', 1, tests.today_a(),
  p_home_id => tests.i('home-a'));
select tests.attach('alice', 'f-s2-own', tests.occ('s2', tests.today_a() + 1), 'this');
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'kept')::integer = 1 and (impact ->> 'removed')::integer = 0
   from public.update_task_series(tests.occ('s2', tests.today_a()), 'series',
     tests.rev(tests.occ('s2', tests.today_a())), tests.srev('s2'),
     false, p_set_schedule => true, p_frequency => 'daily', p_interval => 3, p_starts_on => tests.today_a())),
  'A schedule change keeps the occurrence with its own file');
select tests.act_as_owner();
select tests.assert_true(
  (select detached from private.tasks where id = tests.occ('s2', tests.today_a() + 1))
    and tests.file_status('f-s2-own') = 'ready' and tests.links(tests.occ('s2', tests.today_a() + 1)) = 1,
  'It is kept as changed on its own, with its file');

-- A series-wide file cannot be added from a completed occurrence (which a series change never
-- touches): refused before anything is saved.
select tests.act_as('alice');
select public.set_task_completion(tests.occ('s2', tests.today_a()), true);
select tests.assert_true(
  not (public.list_task_attachments(tests.occ('s2', tests.today_a())) ->> 'canChangeSeries')::boolean,
  'A completed occurrence offers no series-wide change');
select tests.assert_true(tests.intent('f-s2-done', tests.occ('s2', tests.today_a())) = 'ok'
  and tests.finalize('alice', 'f-s2-done') = 'ready', 'setup: a finished upload on the completed occurrence');
select tests.assert_true(
  (select outcome = 'scope_unavailable' and attachment_id is null
   from public.attach_task_file(tests.i('f-s2-done'), 'series')),
  'The series scope from a completed occurrence is refused');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.task_series_attachments where file_id = tests.i('f-s2-done'))
    and not exists (select 1 from private.task_attachments where file_id = tests.i('f-s2-done')),
  'Nothing was saved for it');

-- A chain holds at most 10 series attachments.
do $$
declare
  v_pool uuid := (private.lock_storage_pool(null, tests.i('home-a'))).id;
  v_file uuid;
begin
  for i in 1..10 loop
    insert into private.stored_files (pool_id, purpose, created_by, request_id, upload_key, object_key,
      declared_type, declared_size, content_type, size_bytes, sha256, status, expires_at, finalized_at)
    values (v_pool, 'task_attachment', tests.user_id('alice'), gen_random_uuid(), private.new_object_key('h'),
      private.new_object_key('h'), 'application/pdf', 10, 'application/pdf', 10, repeat('d', 64),
      'ready', now() + interval '15 minutes', now())
    returning id into v_file;
    insert into private.task_series_attachments (root_id, owner_user_id, owner_home_id, file_id, display_name, added_by)
      values (tests.i('s2'), null, tests.i('home-a'), v_file, 'Filler.pdf', tests.user_id('alice'));
  end loop;
end
$$;
insert into ids select 's2-open', id from private.tasks
  where series_root_id = tests.i('s2') and completed_at is null and deleted_at is null
  order by occurrence_date limit 1;
select tests.act_as('alice');
select tests.assert_true(tests.intent('f-s2-cap', tests.i('s2-open')) = 'ok'
  and tests.finalize('alice', 'f-s2-cap') = 'ready', 'setup: a finished upload on an open occurrence');
select tests.assert_true(
  (select outcome = 'limit_reached' from public.attach_task_file(tests.i('f-s2-cap'), 'series')),
  'A chain with 10 series attachments takes no more');
select tests.assert_true(
  (select outcome = 'attached' from public.attach_task_file(tests.i('f-s2-cap'), 'this')),
  'The same file can still be added to this occurrence alone');

-- Departure ------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-carol'))$$, 1,
  'setup: Carol reads while a member');
select tests.act_as_owner();
delete from public.home_memberships where id = tests.i('m-carol-a');
select tests.act_as('carol');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-carol'))$$, 0,
  'A former member reads nothing at once');
select tests.assert_true(public.list_task_attachments(tests.i('t-carol')) is null,
  'A former member lists nothing');
select tests.act_as('alice');
select tests.assert_row_count($$select * from public.authorize_file_read(tests.i('f-carol'))$$, 1,
  'The file stays with the Home');

-- Audit ----------------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.audit_events where action = 'task.attachment_added'
    and subject_id = tests.i('a:f-carol'))
  and not exists (select 1 from private.audit_events where details::text like '%Receipt%'),
  'Adding is audited by id, never by name');
