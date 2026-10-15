-- S15: file storage and quotas (supabase/migrations/*_file_storage.sql). Alice, Bob and Carol are
-- seeded synthetic accounts. Alice owns Home A, where Carol is a Member; Bob owns Home B, where Alice
-- is a Member. Covers: tables unreachable through the API; intents only into your own pool, with
-- type, size and rate limits and an idempotent request id; finalize only by the server; forged and
-- foreign file ids; expiry; mismatched stored types; full storage at request and at execution, with
-- reservations and recoverable deleted files counting; avatars and the cross-Home read rule; purge
-- releasing space; Home pool usage for storage managers only; warnings once per crossing; one
-- finalize at a time with a few attempts; audit rows; unchosen avatars retired by the expiry job.

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

-- A small helper: opens an intent as the current actor and records its file id under p_name.
create function tests.intent(p_name text, p_size bigint, p_type text default 'image/png')
returns text
  language plpgsql as $$
  declare
    v record;
  begin
    select * into v from public.create_upload_intent('avatar', p_type, p_size, gen_random_uuid());
    if v.outcome = 'ok' then
      insert into ids values (p_name, v.file_id);
    end if;
    return v.outcome;
  end
  $$;
grant execute on function tests.intent(text, bigint, text) to authenticated;

-- Finalizes as the server would (service role) for p_user; returns the outcome.
create function tests.finalize(p_user text, p_name text, p_size bigint, p_type text default 'image/webp')
returns text
  language plpgsql as $$
  begin
    perform tests.act_as_service_role();
    return public.finalize_upload(
      tests.user_id(p_user), (select id from ids where name = p_name), p_type, p_size,
      encode(extensions.digest(p_name, 'sha256'), 'hex')
    );
  end
  $$;
grant execute on function tests.finalize(text, text, bigint, text) to authenticated, service_role;

-- Nothing reachable ------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.stored_files', 'The API cannot read stored files');
select tests.assert_denied('select * from private.storage_pools', 'The API cannot read pools');
select tests.assert_denied(
  $$select public.finalize_upload(tests.user_id('alice'), gen_random_uuid(), 'image/webp', 10, repeat('a', 64))$$,
  'A signed-in person cannot finalize (only the server has verified the bytes)'
);
select tests.assert_denied(
  $$select public.set_storage_allowance(tests.user_id('alice'), null, 999999999999)$$,
  'A signed-in person cannot change an allowance'
);
select tests.assert_denied(
  $$update public.user_preferences set avatar_file_id = gen_random_uuid() where user_id = tests.user_id('alice')$$,
  'The avatar column cannot be written directly'
);
select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.create_upload_intent('avatar', 'image/png', 100, gen_random_uuid())$$,
  'A signed-out visitor cannot open an upload'
);

-- Intents ------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.create_upload_intent('avatar', 'image/gif', 100, gen_random_uuid())$$,
  'An avatar must be JPEG, PNG or WebP', '22023'
);
select tests.assert_denied(
  $$select * from public.create_upload_intent('avatar', 'image/png', 5242881, gen_random_uuid())$$,
  'An avatar upload is at most 5 MB', '22023'
);
select tests.assert_denied(
  $$select * from public.create_upload_intent('avatar', 'image/png', 0, gen_random_uuid())$$,
  'An empty upload is refused', '22023'
);
select tests.assert_denied(
  $$select * from public.create_upload_intent('document', 'image/png', 10, gen_random_uuid())$$,
  'An unknown purpose is refused', '22023'
);

select tests.assert_true(tests.intent('a1', 4000) = 'ok', 'Alice opens an avatar upload');
select tests.act_as_owner();
select tests.assert_true(
  (select f.upload_key ~ '^u/[0-9a-f]{64}$' and f.object_key ~ '^u/[0-9a-f]{64}$'
     and f.upload_key <> f.object_key and p.owner_user_id = tests.user_id('alice')
   from private.stored_files f join private.storage_pools p on p.id = f.pool_id
   where f.id = (select id from ids where name = 'a1')),
  'The keys are random and opaque, and the file sits in Alice''s personal pool'
);
select tests.assert_true(
  exists (select 1 from private.job_outbox o where o.job_name = 'storage-upload-expire'
    and o.payload ->> 'fileId' = (select id::text from ids where name = 'a1')
    and o.available_at > now() + interval '15 minutes'),
  'An intent enqueues its own clean-up for after it ends'
);

-- The same request id is the same intent; a different upload under it is a conflict.
select tests.act_as('alice');
do $$
declare
  v_req uuid := gen_random_uuid();
  v1 record;
  v2 record;
  v3 record;
begin
  select * into v1 from public.create_upload_intent('avatar', 'image/png', 1000, v_req);
  select * into v2 from public.create_upload_intent('avatar', 'image/png', 1000, v_req);
  select * into v3 from public.create_upload_intent('avatar', 'image/png', 2000, v_req);
  perform tests.assert_true(v1.file_id = v2.file_id and v2.outcome = 'ok',
    'Repeating a request id returns the same intent');
  perform tests.assert_true(v3.outcome = 'conflict', 'A request id reused for another upload conflicts');
  perform public.abandon_my_upload(v1.file_id, 'mismatch');
end
$$;

-- Another person's upload is invisible; nobody can abandon it but its owner.
select tests.act_as('bob');
select tests.assert_row_count(
  $$select * from public.get_my_upload((select id from ids where name = 'a1'))$$, 0,
  'Bob cannot see Alice''s upload'
);
select tests.assert_true(
  not public.abandon_my_upload((select id from ids where name = 'a1'), 'mismatch'),
  'Bob cannot abandon Alice''s upload'
);
select tests.act_as('alice');
select tests.assert_row_count(
  $$select * from public.get_my_upload((select id from ids where name = 'a1')) where status = 'pending'$$, 1,
  'Alice sees her own pending upload'
);

-- Finalize ---------------------------------------------------------------------------------------------

select tests.assert_true(tests.finalize('bob', 'a1', 3000) = 'not_found',
  'The server cannot finalize Alice''s upload as Bob (a forged owner)');
select tests.assert_true(
  (select public.finalize_upload(tests.user_id('alice'), gen_random_uuid(), 'image/webp', 10, repeat('a', 64)))
    = 'not_found',
  'A forged file id finalizes nothing');
select tests.act_as('alice');
select tests.assert_true(tests.intent('bad-type', 1000) = 'ok', 'Alice opens another upload');
select tests.assert_true(tests.finalize('alice', 'bad-type', 900, 'image/png') = 'invalid',
  'An avatar must be stored as the processed WebP');
select tests.act_as_owner();
select tests.assert_true(
  (select status from private.stored_files where id = (select id from ids where name = 'bad-type')) = 'failed'
  and (select count(*) from private.storage_object_deletions d join private.stored_files f
       on d.object_key in (f.upload_key, f.object_key)
       where f.id = (select id from ids where name = 'bad-type')) = 2,
  'A refused finalize fails the file and queues both objects for removal'
);

select tests.assert_true(tests.finalize('alice', 'a1', 3000) = 'ready', 'The server finalizes Alice''s upload');
select tests.assert_true(tests.finalize('alice', 'a1', 3000) = 'ready', 'Finalizing again is harmless');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) from private.audit_events a where a.subject_type = 'stored_file'
     and a.subject_id = (select id from ids where name = 'a1') and a.actor_user_id = tests.user_id('alice')
     and a.action in ('stored_file.upload_intent', 'stored_file.finalized')) = 2
  and exists (select 1 from private.audit_events a
     where a.subject_id = (select id from ids where name = 'bad-type')
       and a.action = 'stored_file.finalize_refused' and a.details ->> 'outcome' = 'invalid'),
  'Opening, finalizing and refusing uploads are audited by id');

-- One finalize at a time, and only a few attempts per upload (each costs a download and a decode).
select tests.act_as('alice');
select tests.assert_true(tests.intent('claim', 1000) = 'ok', 'Alice opens an upload to finalize');
select tests.assert_true(public.claim_my_upload((select id from ids where name = 'claim')) = 'claimed',
  'The server claims it before reading the bytes');
select tests.assert_true(public.claim_my_upload((select id from ids where name = 'claim')) = 'busy',
  'A second finalize at the same time is refused');
select tests.act_as('bob');
select tests.assert_true(public.claim_my_upload((select id from ids where name = 'claim')) = 'not_found'
  and not public.release_my_upload((select id from ids where name = 'claim')),
  'Bob can neither claim nor release Alice''s upload');
select tests.act_as('alice');
select tests.assert_true(
  public.release_my_upload((select id from ids where name = 'claim'))
  and public.claim_my_upload((select id from ids where name = 'claim')) = 'claimed'
  and public.release_my_upload((select id from ids where name = 'claim'))
  and public.claim_my_upload((select id from ids where name = 'claim')) = 'claimed'
  and public.release_my_upload((select id from ids where name = 'claim')),
  'A released claim may be taken again (three attempts in all)');
select tests.assert_true(public.claim_my_upload((select id from ids where name = 'claim')) = 'limit',
  'A fourth attempt is refused');
select tests.assert_true(public.claim_my_upload((select id from ids where name = 'a1')) = 'ready',
  'A finished upload is reported ready without a new attempt');
select tests.assert_denied(
  $$select public.abandon_my_upload((select id from ids where name = 'claim'), 'bored')$$,
  'Abandoning needs a known reason', '22023'
);
select tests.act_as_owner();
update private.stored_files set claimed_until = now() - interval '1 second', finalize_attempts = 0
  where id = (select id from ids where name = 'claim');
select tests.act_as('alice');
select tests.assert_true(public.claim_my_upload((select id from ids where name = 'claim')) = 'claimed',
  'An expired lease (a crashed finalize) does not block the upload forever');
select tests.assert_true(public.abandon_my_upload((select id from ids where name = 'claim'), 'invalid_image')
  and public.claim_my_upload((select id from ids where name = 'claim')) = 'not_found',
  'An abandoned upload cannot be claimed again');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.storage_object_deletions d join private.stored_files f
    on d.object_key = f.upload_key where f.id = (select id from ids where name = 'a1')
    and d.reason = 'processed'),
  'The raw upload is queued for removal once processed (the original is not kept)'
);

-- Expiry.
select tests.act_as('alice');
select tests.assert_true(tests.intent('late', 1000) = 'ok', 'Alice opens an upload she will not finish in time');
select tests.act_as_owner();
update private.stored_files set expires_at = now() - interval '1 second'
  where id = (select id from ids where name = 'late');
select tests.act_as('alice');
select tests.assert_true(public.claim_my_upload((select id from ids where name = 'late')) = 'expired',
  'An expired upload cannot be claimed');
select tests.assert_true(tests.finalize('alice', 'late', 900) = 'expired', 'An expired upload cannot be finalized');
select tests.assert_true(
  public.expire_upload((select id from ids where name = 'late')) = 'failed'
  and public.expire_upload((select id from ids where name = 'late')) = 'failed',
  'The expiry job settles it as failed, and running it twice is harmless'
);

-- Avatars and the read rule ------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(public.set_my_avatar((select id from ids where name = 'a1')) = 'not_found',
  'Bob cannot use Alice''s file as his avatar');
select tests.act_as('alice');
select tests.assert_true(public.set_my_avatar((select id from ids where name = 'bad-type')) = 'not_found',
  'A failed file cannot be an avatar');
select tests.assert_true(public.set_my_avatar((select id from ids where name = 'a1')) = 'ok',
  'Alice sets her global avatar');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'a1'))$$, 1,
  'Alice can view her own avatar');

select tests.act_as('carol');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'a1'))$$, 1,
  'Carol (Home A) sees Alice''s global avatar, which is her effective avatar there');
select tests.assert_true(
  (select avatar_file_id from public.home_directory((select id from ids where name = 'home-a'))
   where not is_self and role = 'owner') = (select id from ids where name = 'a1'),
  'The Home A directory shows Alice''s avatar file');
select tests.act_as('bob');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'a1'))$$, 1,
  'Bob (Home B, no override yet) also sees Alice''s global avatar');

-- Alice sets a different avatar in Home B.
select tests.act_as('alice');
select tests.assert_true(tests.intent('b1', 2000) = 'ok', 'Alice opens an upload for Home B');
select tests.assert_true(tests.finalize('alice', 'b1', 1500) = 'ready', 'It is finalized');
select tests.act_as('alice');
select tests.assert_true(
  public.set_my_home_avatar((select id from ids where name = 'home-a'), null) = 'ok'
  and public.set_my_home_avatar(gen_random_uuid(), (select id from ids where name = 'b1')) = 'not_found',
  'An override is only for a Home you belong to');
select tests.assert_true(
  public.set_my_home_avatar((select id from ids where name = 'home-b'), (select id from ids where name = 'b1')) = 'ok',
  'Alice sets her Home B avatar');

select tests.act_as('bob');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'b1'))$$, 1,
  'Bob sees Alice''s Home B avatar');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'a1'))$$, 0,
  'Bob no longer sees Alice''s global avatar: in Home B the override is her avatar');
select tests.act_as('carol');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'b1'))$$, 0,
  'Carol (Home A only) cannot open Alice''s Home B avatar (cross-Home download)');
select tests.act_as('bob');
select tests.assert_true(
  public.set_my_home_avatar((select id from ids where name = 'home-b'), (select id from ids where name = 'b1')) = 'not_found',
  'Bob cannot use Alice''s file in his own Home');

-- Alice leaves Home B: the override goes with her profile and Bob loses access at once.
select tests.act_as('alice');
select public.leave_home((select id from ids where name = 'home-b'));
select tests.act_as('bob');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'b1'))$$, 0,
  'After Alice leaves, Bob can no longer open her Home B avatar');
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'deleted' and purge_after > now() + interval '6 days'
   from private.stored_files where id = (select id from ids where name = 'b1')),
  'The unused override file is retired: recoverable for 7 days');

-- Usage: a deleted file still counts, purge releases it.
select tests.act_as('alice');
select tests.assert_true(
  (select used_bytes = 3000 and deleted_bytes = 1500 from public.my_storage_usage()),
  'Alice''s usage counts the ready avatar and the recoverable deleted one');
select tests.act_as_service_role();
select tests.assert_true(public.purge_stored_file((select id from ids where name = 'b1')) = 'deleted',
  'A deleted file is not purged before its window ends');
select tests.act_as_owner();
update private.stored_files set purge_after = now() - interval '1 second'
  where id = (select id from ids where name = 'b1');
select tests.act_as_service_role();
select tests.assert_true(public.purge_stored_file((select id from ids where name = 'b1')) = 'purged',
  'After the window it is purged');
select tests.act_as('alice');
select tests.assert_true((select deleted_bytes = 0 from public.my_storage_usage()),
  'Purging releases the space');

-- A finished avatar that was never chosen does not count forever: the expiry job retires it.
select tests.act_as('alice');
select tests.assert_true(tests.intent('unused', 700) = 'ok', 'Alice opens one more upload');
select tests.assert_true(tests.finalize('alice', 'unused', 600) = 'ready', 'It is finalized, then never chosen');
select tests.act_as_service_role();
select tests.assert_true(public.expire_upload((select id from ids where name = 'unused')) = 'deleted',
  'The expiry job retires the unchosen avatar (recoverable, then purged)');
select tests.assert_true(public.expire_upload((select id from ids where name = 'a1')) = 'ready',
  'An avatar in use is left alone');
select tests.act_as('alice');
select tests.assert_true(public.set_my_avatar(null) = 'ok', 'Alice removes her global avatar');
select tests.act_as('carol');
select tests.assert_row_count(
  $$select * from public.authorize_file_read((select id from ids where name = 'a1'))$$, 0,
  'A removed avatar is no longer visible to co-members');

-- Full storage -------------------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(public.set_storage_allowance(tests.user_id('bob'), null, 10000),
  'An operator gives Bob a 10 000-byte allowance');
select tests.act_as('bob');
select tests.assert_true(tests.intent('bob1', 6000) = 'ok', 'Bob reserves 6 000 bytes');
select tests.assert_true(tests.intent('bob-too-big', 5000) = 'storage_full',
  'A second upload that would not fit next to the reservation is refused at request time');
select tests.assert_true(tests.intent('bob2', 4000) = 'ok', 'An upload that fits is accepted');
-- The first finalizes larger than any reservation left would allow: refused at execution.
select tests.assert_true(tests.finalize('bob', 'bob1', 6001) = 'storage_full',
  'Finalize re-checks capacity with the real size');
select tests.act_as('bob');
select tests.assert_true(tests.intent('bob3', 5000) = 'ok', 'The failed upload''s reservation is released');
select tests.assert_true(tests.finalize('bob', 'bob3', 5000) = 'ready', 'Bob stores 5 000 bytes');
select tests.assert_true(tests.finalize('bob', 'bob2', 4000) = 'ready', 'and 4 000 more (90%)');
select tests.act_as('bob');
select tests.assert_true(public.set_my_avatar((select id from ids where name = 'bob3')) = 'ok', 'Bob uses one');
select tests.assert_true(public.set_my_avatar((select id from ids where name = 'bob2')) = 'ok',
  'and replaces it: the first is retired but still counts');
select tests.assert_true(tests.intent('bob4', 2000) = 'storage_full',
  'A recoverable deleted file still takes space: no room for 2 000 bytes');
select tests.assert_true(
  (select count(*) from public.notifications where kind = 'storage.personal_warning') = 1
  and (select count(*) from public.notifications where kind = 'storage.personal_critical') = 0,
  'Crossing 80% sent one warning to Bob; 95% was never reached');
select tests.act_as_service_role();
select tests.assert_true(public.set_storage_allowance(tests.user_id('bob'), null, 9100), 'The allowance is lowered');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) from public.notifications where kind = 'storage.personal_critical') = 1
  and (select warning_level = 95 and used_bytes = 4000 and deleted_bytes = 5000 from public.my_storage_usage()),
  'A lower allowance reassesses the warning (95%) and deletes nothing');
select tests.act_as_service_role();
select public.set_storage_allowance(tests.user_id('bob'), null, 1000000);
select public.set_storage_allowance(tests.user_id('bob'), null, 10000);
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) from public.notifications where kind like 'storage.personal_%') = 3,
  'Falling below and crossing again warns again, once per crossing');

-- Rate limits.
select tests.act_as('carol');
select tests.assert_true(
  tests.intent('c1', 10) = 'ok' and tests.intent('c2', 10) = 'ok' and tests.intent('c3', 10) = 'ok'
  and tests.intent('c4', 10) = 'ok' and tests.intent('c5', 10) = 'ok',
  'Carol opens five uploads');
select tests.assert_true(tests.intent('c6', 10) = 'rate_limited', 'A sixth pending upload is refused');

-- Home pool --------------------------------------------------------------------------------------------

select tests.act_as_owner();
insert into private.storage_pools (owner_home_id, allowance_bytes)
  values ((select id from ids where name = 'home-a'), 1000);
insert into private.stored_files (
  pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type, declared_size,
  content_type, size_bytes, sha256, status, expires_at, finalized_at
) values (
  (select id from private.storage_pools where owner_home_id = (select id from ids where name = 'home-a')),
  'avatar', tests.user_id('alice'), gen_random_uuid(), private.new_object_key('h'),
  private.new_object_key('h'), 'image/png', 850, 'image/webp', 850, repeat('b', 64), 'ready',
  now(), now()
);
select private.storage_reassess(
  (select id from private.storage_pools where owner_home_id = (select id from ids where name = 'home-a')));

select tests.act_as('alice');
select tests.assert_true(
  (select used_bytes = 850 and allowance_bytes = 1000 and warning_level = 80
   from public.home_storage_usage((select id from ids where name = 'home-a'))),
  'The Owner sees the Home''s storage');
select tests.assert_true(
  (select count(*) from public.notifications where kind = 'storage.home_warning'
     and home_id = (select id from ids where name = 'home-a')) = 1,
  'The Owner was warned about the Home pool');
select tests.act_as('carol');
select tests.assert_denied(
  $$select * from public.home_storage_usage((select id from ids where name = 'home-a'))$$,
  'A Member cannot see the Home''s storage');
select tests.assert_true(
  (select count(*) from public.notifications where kind like 'storage.home_%') = 0,
  'Members are not warned about the Home pool');
select tests.act_as('bob');
select tests.assert_denied(
  $$select * from public.home_storage_usage((select id from ids where name = 'home-a'))$$,
  'Someone outside the Home gets the same refusal');

-- An Administrator sees it only with the manageHomeSettings right.
select tests.act_as_owner();
update public.home_memberships set role = 'administrator'
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_denied(
  $$select * from public.home_storage_usage((select id from ids where name = 'home-a'))$$,
  'An Administrator without manageHomeSettings cannot see the Home''s storage');
select tests.act_as_owner();
insert into private.home_admin_capabilities (home_id, user_id, capability)
  values ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'manageHomeSettings');
select tests.act_as('carol');
select tests.assert_true(
  (select used_bytes = 850 from public.home_storage_usage((select id from ids where name = 'home-a'))),
  'An Administrator granted manageHomeSettings sees it');

-- Deletions queue ----------------------------------------------------------------------------------------

select tests.act_as_owner();
insert into ids select 'deletion', d.id from private.storage_object_deletions d
  where d.done_at is null order by d.created_at limit 1;
select tests.assert_true(
  exists (select 1 from private.job_outbox o where o.job_name = 'storage-object-delete'
    and o.payload ->> 'deletionId' = (select id::text from ids where name = 'deletion')),
  'Every queued deletion has its job');
select tests.act_as_service_role();
select tests.assert_true(
  (select not done from public.get_storage_object_deletion((select id from ids where name = 'deletion'))),
  'The job reads an open deletion');
select tests.assert_true(
  public.complete_storage_object_deletion((select id from ids where name = 'deletion')),
  'The job marks it done');
select tests.assert_true(
  not public.complete_storage_object_deletion((select id from ids where name = 'deletion'))
  and (select done from public.get_storage_object_deletion((select id from ids where name = 'deletion'))),
  'A repeat changes nothing');
select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.get_storage_object_deletion(gen_random_uuid())$$,
  'A signed-in person cannot read the deletion queue');
