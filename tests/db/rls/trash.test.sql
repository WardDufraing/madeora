-- S16: trash and recovery (supabase/migrations/*_trash_and_recovery.sql). Alice, Bob and Carol are
-- seeded synthetic accounts. Alice owns Home A, where Carol is a Member; Bob owns Home B, where
-- Alice is a Member. The reference record type is the sample (private.trash_samples). Covers: nothing
-- reachable through the API; delete, list, restore round trip; conflicts (taken slot, deleted parent)
-- with resolutions, and that matching names are no conflict; expiry and the purge job (idempotent,
-- no-op after a restore, not before the window ends); files: exclusive ones travel with the item and
-- keep counting, shared ones stay, purged ones are reported; quota while in trash; personal and Home
-- visibility (own deletions, storage managers see all, strangers nothing, revoked members nothing);
-- bulk restore with mixed results; early purge and empty trash with per-item permission; audit.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member'),
  ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'member');

-- Fixtures (run as the database owner; the functions are security definer so a test may call them from
-- any actor and the table checks still use the owner's view).

-- A ready file of p_size bytes in a person's pool (p_home null) or a Home's pool.
create function tests.file(p_name text, p_user text, p_home text, p_size bigint) returns uuid
  language plpgsql security definer as $$
  declare
    v_pool private.storage_pools;
    v_id uuid;
    v_prefix text := case when p_home is null then 'u' else 'h' end;
  begin
    v_pool := private.lock_storage_pool(
      case when p_home is null then tests.user_id(p_user) end,
      case when p_home is not null then (select id from ids where name = p_home) end
    );
    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type, declared_size,
      content_type, size_bytes, sha256, status, expires_at, finalized_at
    ) values (
      v_pool.id, 'avatar', tests.user_id(p_user), gen_random_uuid(), private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), 'image/png', p_size, 'image/webp', p_size, repeat('c', 64),
      'ready', now(), now()
    ) returning id into v_id;
    insert into ids values (p_name, v_id);
    return v_id;
  end
  $$;

-- A sample owned by a person (p_home null) or a Home, optionally with a slot, a parent and a file.
create function tests.sample(
  p_name text, p_user text, p_home text, p_label text default null, p_slot text default null,
  p_parent text default null, p_file text default null
) returns uuid
  language plpgsql security definer as $$
  declare
    v_id uuid;
  begin
    insert into private.trash_samples (
      owner_user_id, owner_home_id, name, slot, parent_id, file_id, created_by
    ) values (
      case when p_home is null then tests.user_id(p_user) end,
      case when p_home is not null then (select id from ids where name = p_home) end,
      coalesce(p_label, p_name), p_slot,
      (select id from ids where name = p_parent), (select id from ids where name = p_file),
      tests.user_id(p_user)
    ) returning id into v_id;
    insert into ids values (p_name, v_id);
    return v_id;
  end
  $$;

-- Deletes a sample as a person (their module's delete function would do the same) and records the
-- entry under 'e-<sample name>'.
create function tests.drop_sample(p_actor text, p_name text) returns uuid
  language plpgsql security definer as $$
  declare
    v_entry uuid;
  begin
    v_entry := private.trash_sample_delete(tests.user_id(p_actor), (select id from ids where name = p_name));
    insert into ids values ('e-' || p_name, v_entry)
      on conflict (name) do update set id = excluded.id;
    return v_entry;
  end
  $$;

create function tests.e(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = 'e-' || p_name; $$;
create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;

-- Pushes an entry (and its files) past the recovery window.
create function tests.age(p_name text) returns void
  language plpgsql security definer as $$
  begin
    update private.trash_entries set deleted_at = now() - interval '8 days',
      expires_at = now() - interval '1 day' where id = tests.e(p_name);
    update private.stored_files set deleted_at = now() - interval '8 days',
      purge_after = now() - interval '1 day'
      where id in (select file_id from private.trash_entry_files where entry_id = tests.e(p_name));
  end
  $$;

create function tests.sample_state(p_name text) returns text
  language sql stable security definer as $$
  select case when s.id is null then 'gone' when s.deleted_at is null then 'active' else 'deleted' end
  from (select 1) x left join private.trash_samples s on s.id = (select id from ids where name = p_name);
  $$;

create function tests.file_state(p_name text) returns text
  language sql stable security definer as $$
  select f.status from private.stored_files f where f.id = (select id from ids where name = p_name);
  $$;

create function tests.intent(p_name text, p_size bigint) returns text
  language plpgsql as $$
  declare
    v record;
  begin
    select * into v from public.create_upload_intent('avatar', 'image/png', p_size, gen_random_uuid());
    if v.outcome = 'ok' then
      insert into ids values (p_name, v.file_id);
    end if;
    return v.outcome;
  end
  $$;

grant execute on function tests.file(text, text, text, bigint), tests.sample(text, text, text, text, text, text, text),
  tests.drop_sample(text, text), tests.e(text), tests.i(text), tests.age(text), tests.sample_state(text),
  tests.file_state(text), tests.intent(text, bigint) to authenticated, service_role;

-- Nothing reachable ------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.trash_entries', 'The API cannot read trash entries');
select tests.assert_denied('select * from private.trash_samples', 'The API cannot read the sample table');
select tests.assert_denied('select * from private.trash_entry_files', 'The API cannot read entry files');
select tests.assert_denied(
  $$select private.trash_sample_delete(tests.user_id('alice'), gen_random_uuid())$$,
  'A signed-in person cannot call the module delete function directly'
);
select tests.assert_denied(
  $$select public.purge_expired_trash_entry(gen_random_uuid())$$,
  'A signed-in person cannot run the purge job'
);
select tests.assert_denied('select * from public.trash_stats()', 'Nor read the runbook stats');
select tests.act_as_anon();
select tests.assert_denied('select * from public.list_trash()', 'Nobody signed out can list a trash');

-- Delete, list, restore: the round trip, with a file ----------------------------------------------------------

select tests.act_as_owner();
select tests.file('f1', 'alice', null, 500);
select tests.sample('s1', 'alice', null, 'Alice sample', 's1-slot', null, 'f1');
select tests.act_as('alice');
select tests.assert_true(
  (select used_bytes = 500 and deleted_bytes = 0 from public.my_storage_usage()),
  'The ready file counts');
select tests.drop_sample('alice', 's1');
select tests.assert_true(tests.sample_state('s1') = 'deleted', 'The item is soft deleted, not removed');
select tests.assert_true(tests.file_state('f1') = 'deleted', 'Its exclusively attached file went to the file trash');
select tests.assert_true(
  (select used_bytes = 0 and deleted_bytes = 500 from public.my_storage_usage()),
  'A trashed file still counts against the allowance');
select tests.assert_row_count($$select * from public.list_trash()$$, 1, 'Alice sees one entry');
select tests.assert_true(
  (select label = 'Alice sample' and module = 'sample' and item_type = 'sample'
     and deleted_by_me and file_count = 1
     and expires_at > now() + interval '6 days 23 hours' and expires_at <= now() + interval '7 days 1 hour'
   from public.list_trash()),
  'The entry shows its label, kind, file count and a 7-day deadline');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.job_outbox o where o.job_name = 'trash-entry-purge'
    and o.payload ->> 'entryId' = tests.e('s1')::text and o.available_at > now() + interval '6 days'),
  'A purge job is queued for the end of the window');

-- Other people see nothing of it.
select tests.act_as('bob');
select tests.assert_row_count($$select * from public.list_trash()$$, 0, 'Bob''s personal trash is empty');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('s1')])) = 'not_found',
  'Bob cannot restore Alice''s entry, and is told it does not exist');
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[tests.e('s1')])) = 'not_found',
  'Bob cannot purge Alice''s entry');
select tests.assert_denied(
  $$select * from public.list_trash((select id from ids where name = 'home-a'))$$,
  'Bob cannot list a Home he is not in');
select tests.assert_true(tests.sample_state('s1') = 'deleted' and tests.file_state('f1') = 'deleted',
  'Nothing of Alice''s changed');

-- Restore: the item and its file come back, the space is not charged twice.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' and attachments_lost = 0
   from public.restore_trash_entries(array[tests.e('s1')])),
  'Alice restores it');
select tests.assert_true(tests.sample_state('s1') = 'active' and tests.file_state('f1') = 'ready',
  'The item and its file are back');
select tests.assert_true(
  (select used_bytes = 500 and deleted_bytes = 0 from public.my_storage_usage()),
  'Restoring does not charge the file twice');
select tests.assert_row_count($$select * from public.list_trash()$$, 0, 'The trash is empty again');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('s1')])) = 'not_found',
  'A repeated restore does nothing and creates no duplicate');
select tests.assert_true(
  (select count(*) from public.list_trash()) = 0
  and (select count(*) from public.my_storage_usage() where used_bytes = 500) = 1,
  'Still one file, one item');

-- A second delete makes a fresh entry (the restored one is history).
select tests.drop_sample('alice', 's1');
select tests.assert_true(tests.file_state('f1') = 'deleted', 'Deleting again trashes the file again');
select tests.assert_row_count($$select * from public.list_trash()$$, 1, 'One entry again');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('s1')])) = 'restored', 'And it restores again');

-- Conflicts -------------------------------------------------------------------------------------------------

-- A taken slot is a conflict; the same name alone is not.
select tests.act_as_owner();
select tests.sample('c1', 'alice', null, 'Same name', 'slot-x');
select tests.sample('c2', 'alice', null, 'Same name', null);
select tests.act_as('alice');
select tests.drop_sample('alice', 'c1');
select tests.drop_sample('alice', 'c2');
select tests.act_as_owner();
select tests.sample('c1-active', 'alice', null, 'Same name', 'slot-x');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('c2')])) = 'restored',
  'Two items with the same name are not a conflict');
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'slot_taken' and options = array['clear_slot']
   from public.restore_trash_entries(array[tests.e('c1')])),
  'A slot taken by an active item needs the person to choose');
select tests.assert_true(tests.sample_state('c1') = 'deleted', 'Nothing was restored or overwritten meanwhile');
select tests.assert_true(
  (select outcome = 'needs_resolution' from public.restore_trash_entries(
    array[tests.e('c1')], jsonb_build_object(tests.e('c1')::text, 'detach_parent'))),
  'A resolution that does not answer the conflict is ignored');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(
    array[tests.e('c1')], jsonb_build_object(tests.e('c1')::text, 'clear_slot'))),
  'Choosing "restore without the slot" restores it');
select tests.act_as_owner();
select tests.assert_true(
  (select slot is null from private.trash_samples where id = tests.i('c1'))
  and (select slot = 'slot-x' from private.trash_samples where id = tests.i('c1-active')),
  'The active item keeps its slot, the restored one lost its slot');

-- A deleted parent is a conflict for its child; restoring the parent first clears it.
select tests.sample('p1', 'alice', null, 'Parent');
select tests.sample('k1', 'alice', null, 'Child', null, 'p1');
select tests.sample('p2', 'alice', null, 'Parent two');
select tests.sample('k2', 'alice', null, 'Child two', null, 'p2');
select tests.act_as('alice');
select tests.drop_sample('alice', 'k1');
select tests.drop_sample('alice', 'p1');
select tests.drop_sample('alice', 'k2');
select tests.drop_sample('alice', 'p2');
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'parent_unavailable' and options = array['detach_parent']
   from public.restore_trash_entries(array[tests.e('k1')])),
  'A child whose parent is in the trash needs a choice');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('p2')])) = 'restored',
  'Restoring the parent first');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('k2')])) = 'restored',
  'Its child then restores without any choice');
select tests.act_as_owner();
select tests.assert_true(
  (select parent_id = tests.i('p2') from private.trash_samples where id = tests.i('k2')),
  'And keeps its parent');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(
    array[tests.e('k1')], jsonb_build_object(tests.e('k1')::text, 'detach_parent'))),
  'Choosing "restore without the parent" restores the child');
select tests.act_as_owner();
select tests.assert_true(
  (select parent_id is null from private.trash_samples where id = tests.i('k1')),
  'It is detached');

-- Expiry and the purge job ------------------------------------------------------------------------------------

select tests.file('f2', 'alice', null, 300);
select tests.sample('x1', 'alice', null, 'Expiring', null, null, 'f2');
select tests.sample('x2', 'alice', null, 'Restored first');
select tests.act_as('alice');
select tests.drop_sample('alice', 'x1');
select tests.drop_sample('alice', 'x2');
select tests.act_as_service_role();
select tests.assert_true(public.purge_expired_trash_entry(tests.e('x1')) = 'trashed',
  'The job does nothing before the window ends');
select tests.act_as('alice');
select tests.assert_true((select outcome from public.restore_trash_entries(array[tests.e('x2')])) = 'restored', 'x2 is restored');
select tests.act_as_owner();
select tests.age('x1');
update private.trash_entries set deleted_at = now() - interval '8 days', expires_at = now() - interval '1 day'
  where id = tests.e('x2');  -- already restored: must stay untouched by the job
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('x1')])) = 'expired',
  'An entry past its window can no longer be restored');
select tests.assert_row_count($$select * from public.list_trash() where label = 'Expiring'$$, 0,
  'It is no longer offered');
select tests.act_as_service_role();
select tests.assert_true(public.purge_expired_trash_entry(tests.e('x2')) = 'restored', 'The job leaves a restored entry alone');
select tests.assert_true(tests.sample_state('x2') = 'active', 'And its item');
select tests.assert_true(public.purge_expired_trash_entry(tests.e('x1')) = 'purged', 'The job purges an expired entry');
select tests.assert_true(tests.sample_state('x1') = 'gone' and tests.file_state('f2') = 'purged',
  'The item is removed and its file purged');
select tests.assert_true(public.purge_expired_trash_entry(tests.e('x1')) = 'purged', 'A repeat is harmless');
select tests.assert_true(public.purge_expired_trash_entry(gen_random_uuid()) = 'missing', 'An unknown entry is missing');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.storage_object_deletions d
    join private.stored_files f on f.object_key = d.object_key and d.reason = 'purged'
    where f.id = tests.i('f2')),
  'The file''s object is queued for removal');
select tests.assert_true((select label is null from private.trash_entries where id = tests.e('x1')),
  'A purged entry keeps no title');

-- Files: shared stays, purged is reported -------------------------------------------------------------------------

select tests.file('f3', 'alice', null, 200);
select tests.sample('sh1', 'alice', null, 'Shares file', null, null, 'f3');
select tests.sample('sh2', 'alice', null, 'Also uses file', null, null, 'f3');
select tests.act_as('alice');
select tests.drop_sample('alice', 'sh1');
select tests.assert_true(tests.file_state('f3') = 'ready',
  'A file another active item uses stays available');
select tests.assert_true((select file_count = 0 from public.list_trash() where label = 'Shares file'),
  'The entry holds no file');
select tests.drop_sample('alice', 'sh2');
select tests.assert_true(tests.file_state('f3') = 'deleted', 'Once nothing active uses it, it is trashed with the last item');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.e('sh1')])),
  'Restoring the first item');
select tests.assert_true(tests.file_state('f3') = 'ready', 'It brings the file it uses back');
select tests.assert_true(
  (select outcome = 'restored' and attachments_lost = 0 from public.restore_trash_entries(array[tests.e('sh2')])),
  'The second item restores too');
select tests.assert_true(
  (select used_bytes >= 200 from public.my_storage_usage()) and tests.file_state('f3') = 'ready',
  'No double charge, file available to both');

-- A file purged meanwhile (by its own window or an early delete) is dropped and reported.
select tests.act_as_owner();
select tests.file('f4', 'alice', null, 100);
select tests.sample('lost', 'alice', null, 'Lost file', null, null, 'f4');
select tests.act_as('alice');
select tests.drop_sample('alice', 'lost');
select tests.act_as_owner();
select private.purge_file_now(tests.i('f4'));
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' and attachments_lost = 1 from public.restore_trash_entries(array[tests.e('lost')])),
  'The item restores and the lost attachment is reported');
select tests.act_as_owner();
select tests.assert_true(
  (select file_id is null from private.trash_samples where id = tests.i('lost')) and tests.file_state('f4') = 'purged',
  'No broken reference is left behind');

-- Quota while in trash ----------------------------------------------------------------------------------------------

select tests.act_as_owner();
select public.set_storage_allowance(tests.user_id('bob'), null, 1000);
select tests.file('q1', 'bob', null, 600);
select tests.sample('q', 'bob', null, 'Big', null, null, 'q1');
select tests.act_as('bob');
select tests.drop_sample('bob', 'q');
select tests.assert_true(tests.intent('q-too-big', 500) = 'storage_full',
  'A trashed file still blocks new uploads: 600 + 500 does not fit in 1000');
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[tests.e('q')])) = 'purged', 'Bob deletes it for good');
select tests.assert_true(tests.intent('q-fits', 500) = 'ok', 'The space is free again');
select tests.assert_true((select deleted_bytes = 0 from public.my_storage_usage()), 'Nothing recoverable remains');

-- Home trash: who sees what ---------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.file('hf', 'alice', 'home-a', 400);
select tests.sample('h-alice', 'alice', 'home-a', 'By Alice', null, null, 'hf');
select tests.sample('h-carol', 'carol', 'home-a', 'By Carol');
select tests.sample('h-carol2', 'carol', 'home-a', 'By Carol two');
select tests.sample('h-bob', 'bob', 'home-b', 'Bob Home');
select tests.act_as('alice');
select tests.drop_sample('alice', 'h-alice');
select tests.act_as('carol');
select tests.drop_sample('carol', 'h-carol');
select tests.drop_sample('carol', 'h-carol2');
select tests.act_as('bob');
select tests.drop_sample('bob', 'h-bob');

select tests.act_as('alice');
select tests.assert_row_count(
  $$select * from public.list_trash((select id from ids where name = 'home-a'))$$, 3,
  'The Owner sees every entry in the Home trash');
select tests.assert_row_count($$select * from public.list_trash() where label = 'By Alice'$$, 0,
  'Home items are not in Alice''s personal trash');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 2 and bool_and(deleted_by_me) from public.list_trash((select id from ids where name = 'home-a'))),
  'A Member sees only what they deleted');
select tests.assert_denied(
  $$select * from public.list_trash((select id from ids where name = 'home-b'))$$,
  'Carol cannot list a Home she is not in');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 1 from public.list_trash((select id from ids where name = 'home-b'))),
  'Bob sees his own Home''s trash');
select tests.assert_denied(
  $$select * from public.list_trash((select id from ids where name = 'home-a'))$$,
  'Bob cannot list Home A, whether or not it exists');

-- A Member cannot restore or purge somebody else's entry; the Owner can act on anyone's.
select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('h-alice')])) = 'not_found',
  'Carol cannot restore Alice''s entry');
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[tests.e('h-alice')])) = 'not_found',
  'Carol cannot purge it');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('h-carol')])) = 'restored',
  'Carol restores her own');
select tests.assert_true(tests.file_state('hf') = 'deleted', 'Alice''s Home file is untouched');
select tests.act_as('alice');
select tests.assert_true(
  (select used_bytes = 0 and deleted_bytes = 400 from public.home_storage_usage((select id from ids where name = 'home-a'))),
  'The Home pool still counts the trashed file');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('h-alice')])) = 'restored',
  'The Owner restores into the Home it came from');
select tests.assert_true(
  (select used_bytes = 400 and deleted_bytes = 0 from public.home_storage_usage((select id from ids where name = 'home-a'))),
  'Home usage is the same, nothing counted twice');

-- Administrators granted manageHomeSettings see all; ungranted ones only their own; removed members nothing.
select tests.act_as_owner();
update public.home_memberships set role = 'administrator'
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
select tests.act_as('alice');
select tests.drop_sample('alice', 'h-alice');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 and bool_and(deleted_by_me) from public.list_trash((select id from ids where name = 'home-a'))),
  'An Administrator without the grant sees only their own');
select tests.act_as_owner();
insert into private.home_admin_capabilities (home_id, user_id, capability)
  values ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'manageHomeSettings');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 2 from public.list_trash((select id from ids where name = 'home-a'))),
  'With manageHomeSettings an Administrator sees the whole Home trash');
select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_denied(
  $$select * from public.list_trash((select id from ids where name = 'home-a'))$$,
  'Once removed from the Home, Carol sees nothing of its trash');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('h-carol2')])) = 'not_found',
  'And cannot restore even what she deleted herself');
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[tests.e('h-carol2')])) = 'not_found',
  'Or purge it');
select tests.assert_true(
  (select count(*) from public.empty_trash(null, now() + interval '1 minute')) = 0, 'Her personal empty trash touches nothing of the Home');

-- Bulk restore: every item on its own ------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.sample('b-ok', 'alice', null, 'Bulk ok');
select tests.sample('b-conflict', 'alice', null, 'Bulk conflict', 'bulk-slot');
select tests.sample('b-expired', 'alice', null, 'Bulk expired');
select tests.act_as('alice');
select tests.drop_sample('alice', 'b-ok');
select tests.drop_sample('alice', 'b-conflict');
select tests.drop_sample('alice', 'b-expired');
select tests.act_as_owner();
select tests.sample('b-blocker', 'alice', null, 'Blocker', 'bulk-slot');
select tests.age('b-expired');
select tests.act_as('alice');
create temporary table bulk on commit drop as
  select * from public.restore_trash_entries(
    array[tests.e('b-ok'), tests.e('b-conflict'), tests.e('b-expired'), tests.e('h-bob'), gen_random_uuid(), tests.e('b-ok')]
  );
select tests.assert_true(
  (select count(*) = 5 from bulk) and
  (select outcome = 'restored' from bulk where entry_id = tests.e('b-ok'))
  and (select outcome = 'needs_resolution' from bulk where entry_id = tests.e('b-conflict'))
  and (select outcome = 'expired' from bulk where entry_id = tests.e('b-expired'))
  and (select count(*) = 2 and bool_and(outcome = 'not_found') from bulk
       where entry_id not in (tests.e('b-ok'), tests.e('b-conflict'), tests.e('b-expired'))),
  'Mixed ids: restored, needs resolution, expired, and a foreign and an unknown id both not_found; duplicates collapse');
select tests.assert_true(tests.sample_state('b-ok') = 'active' and tests.sample_state('b-conflict') = 'deleted',
  'The safe one was restored, the conflicting one untouched');
select tests.assert_denied($$select * from public.restore_trash_entries(array[]::uuid[])$$,
  'An empty request is refused', '22023');
select tests.assert_denied($$select * from public.restore_trash_entries(null)$$, 'A missing list is refused', '22023');
select tests.assert_denied(
  $$select * from public.restore_trash_entries(array(select gen_random_uuid() from generate_series(1, 101)))$$,
  'More than one batch is refused', '22023');
select tests.assert_denied(
  $$select * from public.restore_trash_entries(array[gen_random_uuid()], '[]'::jsonb)$$,
  'Resolutions must be an object', '22023');

-- Early permanent deletion and Empty trash ---------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.file('pf', 'alice', null, 250);
select tests.sample('pg', 'alice', null, 'Purge me', null, null, 'pf');
select tests.act_as('alice');
select tests.drop_sample('alice', 'pg');
select tests.assert_true(
  (select deleted_bytes >= 250 from public.my_storage_usage()), 'It counts while in the trash');
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[tests.e('pg')])) = 'purged', 'Alice deletes it permanently');
select tests.assert_true(tests.sample_state('pg') = 'gone' and tests.file_state('pf') = 'purged', 'Item gone, file purged');
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[tests.e('pg')])) = 'not_found', 'Repeating does nothing');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.e('pg')])) = 'not_found', 'A purged entry cannot be restored');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.storage_object_deletions d
    join private.stored_files f on f.object_key = d.object_key and d.reason = 'purged' where f.id = tests.i('pf')),
  'The object is queued for removal');

-- Empty trash touches only what was deleted before the cutoff the page was loaded with, and never
-- an entry past its window.
select tests.act_as_owner();
select tests.sample('cut', 'alice', null, 'After the page loaded');
select tests.act_as('alice');
select tests.drop_sample('alice', 'cut');
select tests.assert_denied($$select * from public.empty_trash(null, null)$$, 'A cutoff is required', '22023');
select tests.assert_true(
  (select count(*) = 0 from public.empty_trash(null, now() - interval '1 hour')),
  'Nothing deleted after the cutoff is emptied');
select tests.assert_true(tests.sample_state('cut') = 'deleted', 'So the later deletion is still in the trash');

-- Empty trash: Alice's personal trash goes, Home trash and other people's are untouched.
select tests.act_as('alice');
create temporary table emptied on commit drop as select * from public.empty_trash(null, now() + interval '1 minute');
select tests.assert_true(
  (select count(*) >= 2 and bool_and(outcome = 'purged') from emptied), 'Empty trash purges what Alice may purge');
select tests.assert_row_count($$select * from public.list_trash()$$, 0, 'Her personal trash is empty');
select tests.assert_true(
  (select count(*) = 2 from public.list_trash((select id from ids where name = 'home-a'))),
  'The Home trash is separate and unaffected');
select tests.act_as('alice');
create temporary table emptied_home on commit drop as
  select * from public.empty_trash((select id from ids where name = 'home-a'), now() + interval '1 minute');
select tests.assert_true((select count(*) = 2 and bool_and(outcome = 'purged') from emptied_home),
  'Emptying the Home trash purges it for the Owner');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 1 from public.list_trash((select id from ids where name = 'home-b'))),
  'Bob''s Home trash is untouched by another Home''s');
select tests.assert_denied(
  $$select * from public.empty_trash((select id from ids where name = 'home-a'), now() + interval '1 minute')$$,
  'Bob cannot empty a Home he is not in');

-- Audit --------------------------------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) > 0 from private.audit_events a where a.action = 'trash_entry.moved' and a.subject_type = 'trash_entry')
  and (select count(*) > 0 from private.audit_events a where a.action = 'trash_entry.restored')
  and (select count(*) > 0 from private.audit_events a where a.action = 'trash_entry.purged'),
  'Moving, restoring and purging are audited');
select tests.assert_true(
  not exists (select 1 from private.audit_events a where a.subject_type = 'trash_entry'
    and a.details::text ~* '(Alice sample|Bulk|Same name|Parent)'),
  'The audit trail never holds a title');
select tests.sample('st', 'alice', null, 'Overdue');
select tests.drop_sample('alice', 'st');
select tests.age('st');
select tests.act_as_service_role();
select tests.assert_true(
  (select open_entries >= 1 and overdue_entries >= 1 from public.trash_stats()),
  'The runbook stats count open and overdue entries');
