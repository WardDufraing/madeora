-- S21: member proposals and targeted volunteer requests
-- (supabase/migrations/*_chore_proposals_volunteers.sql). Alice owns Home A (Europe/Brussels), where
-- Bob is an Administrator (no chore rights), Carol, Dave and Erin Members; Bob owns Home B.
-- Covers: nothing reachable as a table; proposals (submit, retry, duplicate, bad date and category,
-- visibility, withdraw, reject with feedback, approve revised into one unassigned chore, a second
-- decision, self-approval by a manager, the notice, departure); volunteer requests (only for
-- occurrences in review, rights, preview, roster privacy, decline, first acceptance wins, the others
-- closed, withdrawal, adding recipients, cancel, direct assignment resolves, expiry at the deadline
-- and a stale acceptance, no reopening, departure of the last invitee, correction with a reason);
-- audit without titles.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '31000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '31000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'erin@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '31000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'finn@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member'),
  ((select id from ids where name = 'home-a'), '31000000-0000-4000-8000-000000000001', 'member'),
  ((select id from ids where name = 'home-a'), '31000000-0000-4000-8000-000000000002', 'member'),
  ((select id from ids where name = 'home-a'), '31000000-0000-4000-8000-000000000003', 'member');
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m
  join auth.users x on x.id = m.user_id, unnest(array['alice', 'bob', 'carol', 'dave', 'erin', 'finn']) u
  where m.home_id = (select id from ids where name = 'home-a') and x.email = u || '@madeora.test';
insert into ids select n, gen_random_uuid() from unnest(array[
  'p1', 'p2', 'p3', 'p4', 'p5', 'c-rev', 'c-rev2', 'c-rev3', 'v1', 'v2', 'v3', 'v4', 'v5'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.first_occ(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) order by scheduled_date limit 1; $$;
create function tests.occ_rev(p_occurrence uuid) returns integer
  language sql stable security definer as $$ select revision from private.chore_occurrences where id = p_occurrence; $$;
create function tests.who(p_occurrence uuid) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(split_part(u.email, '@', 1), ',' order by u.email), '')
  from private.chore_occurrence_assignees a join auth.users u on u.id = a.user_id
  where a.occurrence_id = p_occurrence; $$;
create function tests.flagged(p_occurrence uuid) returns boolean
  language sql stable security definer as $$
  select needs_reassignment from private.chore_occurrences where id = p_occurrence; $$;
create function tests.events(p_occurrence uuid) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(kind || coalesce(':' || reason, ''), ',' order by id), '')
  from private.chore_occurrence_events where occurrence_id = p_occurrence; $$;
create function tests.request(p_request text) returns text
  language sql stable security definer as $$
  select status from private.chore_volunteer_requests where id = tests.i(p_request); $$;
create function tests.invitations(p_request text) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(split_part(u.email, '@', 1) || ':' || i.status, ',' order by u.email), '')
  from private.chore_volunteer_invitations i join auth.users u on u.id = i.user_id
  where i.request_id = tests.i(p_request); $$;
create function tests.proposal(p_name text) returns text
  language sql stable security definer as $$ select status from private.chore_proposals where id = tests.i(p_name); $$;
create function tests.proposal_rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.chore_proposals where id = tests.i(p_name); $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications n join auth.users u on u.id = n.user_id
  where u.email = p_user || '@madeora.test' and n.kind = p_kind; $$;
create function tests.move_due(p_occurrence uuid, p_days integer) returns void
  language sql security definer as $$
  update private.chore_occurrences set due_date = due_date + p_days, scheduled_date = scheduled_date + p_days
  where id = p_occurrence; $$;
-- A boolean query over private tables, read as the database owner (the API roles cannot).
create function tests.sd(p_query text) returns boolean
  language plpgsql security definer as $$
  declare
    v_result boolean;
  begin
    execute 'select (' || p_query || ')' into v_result;
    return v_result;
  end $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable ----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.chore_proposals', 'The API cannot read proposals');
select tests.assert_denied('select * from private.chore_volunteer_requests', 'Nor volunteer requests');
select tests.assert_denied('select * from private.chore_volunteer_invitations', 'Nor invitations');
select tests.act_as_anon();
select tests.assert_denied(
  format($$select public.list_chore_proposals(%L)$$, gen_random_uuid()), 'Signed-out people read no proposals');

-- Proposals ------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied(
  format($$select * from public.propose_chore(%L, %L, 'Kot chore', %L)$$, tests.i('p5'), tests.i('home-b'), tests.today_a()),
  'Carol cannot propose in a Home she is not in');
select tests.assert_true(
  (select outcome = 'proposed' and revision = 1 from public.propose_chore(tests.i('p1'), tests.i('home-a'),
    'Clean the garage', tests.today_a() + 2, '[{"label": "Sweep", "mandatory": true}]',
    'Mind the bikes', null, 45)),
  'Carol, a Member, proposes a chore');
select tests.assert_true(
  (select outcome = 'exists' from public.propose_chore(tests.i('p1'), tests.i('home-a'), 'Clean the garage',
    tests.today_a() + 2)),
  'A retry with the same id answers exists');
select tests.assert_true(
  (select outcome = 'duplicate' from public.propose_chore(tests.i('p2'), tests.i('home-a'), 'clean THE garage',
    tests.today_a() + 3)),
  'She cannot propose the same title twice while it waits');
select tests.assert_true(
  (select outcome = 'invalid_date' from public.propose_chore(tests.i('p2'), tests.i('home-a'), 'Attic',
    tests.today_a() - 1)),
  'Not for a day in the past');
select tests.assert_true(
  (select outcome = 'invalid_category' from public.propose_chore(tests.i('p2'), tests.i('home-a'), 'Attic',
    tests.today_a(), p_category_id => gen_random_uuid())),
  'Nor with a category of no Home');
select tests.assert_true(
  (select outcome = 'proposed' from public.propose_chore(tests.i('p2'), tests.i('home-a'), 'Attic', tests.today_a())),
  'A second proposal');

select tests.act_as_user('31000000-0000-4000-8000-000000000001');
select tests.assert_true(
  (select (l ->> 'canReview')::boolean = false and jsonb_array_length(l -> 'proposals') = 0
   from public.list_chore_proposals(tests.i('home-a')) l),
  'Dave, another Member, does not see Carol''s proposals');
select tests.assert_true(
  (select outcome = 'proposed' from public.propose_chore(tests.i('p3'), tests.i('home-a'), 'Clean the garage',
    tests.today_a() + 1)),
  'Dave proposes the same title (someone else may)');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.review_chore_proposal(tests.i('p1'), 1, 'reject', 'No')),
  'A Member cannot review');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.review_chore_proposal(tests.i('p1'), 1, 'reject', 'No')),
  'Nor an Administrator without chore rights');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.withdraw_chore_proposal(tests.i('p3'), 1)),
  'Carol cannot withdraw Dave''s proposal');
select tests.assert_true(
  (select outcome = 'withdrawn' from public.withdraw_chore_proposal(tests.i('p2'), 1)),
  'She withdraws her own');
select tests.assert_true(
  (select outcome = 'withdrawn' from public.withdraw_chore_proposal(tests.i('p2'), 2)),
  'A retry answers withdrawn again');

select tests.act_as('alice');
select tests.assert_true(
  (select (l ->> 'canReview')::boolean and (l ->> 'pendingCount')::integer = 2
     and jsonb_array_length(l -> 'proposals') = 3
     and (select bool_and((p ->> 'possibleDuplicate')::boolean) from jsonb_array_elements(l -> 'proposals') p
          where p ->> 'status' = 'pending')
   from public.list_chore_proposals(tests.i('home-a')) l),
  'Alice sees the two waiting proposals (marked as possible duplicates) and the withdrawn one');
select tests.assert_denied(
  format($$select * from public.review_chore_proposal(%L, 1, null, 'because')$$, tests.i('p3')),
  'A review without a decision is refused, never taken as approval', '22023');
select tests.assert_true(
  (select outcome = 'rejected' from public.review_chore_proposal(tests.i('p3'), 1, 'reject', '  Already proposed  ')),
  'Alice rejects Dave''s duplicate with a reason');
select tests.assert_true(
  tests.sd($q$select feedback = 'Already proposed' from private.chore_proposals where id = tests.i('p3')$q$),
  'The reason is kept, tidied');
select tests.assert_true(
  (select outcome = 'conflict' from public.review_chore_proposal(tests.i('p1'), 7, 'approve', null,
    'Clean the garage', tests.today_a() + 2, '[]')),
  'A stale revision is a conflict');
select tests.assert_true(
  (select outcome = 'approved' and occurrence_id is not null from public.review_chore_proposal(tests.i('p1'), 1,
    'approve', null, 'Clean the garage and the shed', tests.today_a() + 3,
    '[{"label": "Sweep", "mandatory": true}, {"label": "Bins", "mandatory": false}]', 'Mind the bikes', null, 60)),
  'Alice approves Carol''s proposal, revised');
select tests.assert_true(
  tests.sd($q$select c.title = 'Clean the garage and the shed' and c.kind = 'one_off' and c.claim_mode = 'all'
     and o.due_date = tests.today_a() + 3 and o.estimated_minutes = 60 and tests.who(o.id) = ''
     and (select count(*) from private.chore_occurrence_steps s where s.occurrence_id = o.id) = 2
   from private.chores c join private.chore_occurrences o on o.chore_id = c.id where c.id = tests.i('p1')$q$),
  'It is published as one unassigned one-off chore with the final details, its id the proposal''s');
select tests.assert_true(
  tests.sd($q$select status = 'approved' and revised from private.chore_proposals where id = tests.i('p1')$q$),
  'The proposal is approved and marked as revised');
select tests.assert_true(
  (select outcome = 'not_open' and status = 'approved' and occurrence_id = tests.first_occ('p1')
   from public.review_chore_proposal(tests.i('p1'), 2, 'approve', null, 'Again', tests.today_a(), '[]')),
  'A second decision publishes nothing more');
select tests.assert_true(
  tests.sd($q$select count(*) = 1 from private.chores where id = tests.i('p1')$q$), 'Exactly one chore');
select tests.assert_true(
  tests.notices('carol', 'chore.proposal_decided') = 1 and tests.notices('dave', 'chore.proposal_decided') = 1,
  'Both proposers are told');
select tests.assert_true(
  (select outcome = 'proposed' from public.propose_chore(tests.i('p4'), tests.i('home-a'), 'Windows', tests.today_a())),
  'Alice proposes a chore herself');
select tests.assert_true(
  (select outcome = 'approved' from public.review_chore_proposal(tests.i('p4'), 1, 'approve', null, 'Windows',
    tests.today_a(), '[]')),
  'And approves it, as a chore manager');
select tests.assert_true(tests.notices('alice', 'chore.proposal_decided') = 0, 'She is not told about her own decision');
select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_array_length(l -> 'proposals') = 2
     and (select bool_and(p ->> 'possibleDuplicate' = 'false') from jsonb_array_elements(l -> 'proposals') p)
   from public.list_chore_proposals(tests.i('home-a')) l),
  'Carol sees her own two proposals, without the reviewers'' duplicate mark');
select tests.assert_true(
  (select outcome = 'proposed' from public.propose_chore(tests.i('p5'), tests.i('home-a'), 'Shed roof', tests.today_a())),
  'One more waiting proposal by Carol');

-- Volunteer requests: an occurrence in review --------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-rev'), tests.i('home-a'), 'Recycling',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-finn-a'))),
    '[{"label": "Glass", "mandatory": false}]', 'Rinse first', p_minutes => 20, p_due_date => tests.today_a() + 1)),
  'A chore assigned to Finn');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-rev2'), tests.i('home-a'), 'Compost',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-finn-a'))),
    p_due_date => tests.today_a() + 1)),
  'Another one');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-rev3'), tests.i('home-a'), 'Gutters',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-finn-a'))),
    p_due_date => tests.today_a() + 1)),
  'And a third');
select tests.assert_true(
  (select outcome = 'not_in_review' from public.create_chore_volunteer_request(tests.i('v1'), tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), array[tests.i('m-carol-a')], true)),
  'An assigned occurrence is not in review: no volunteer request');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = '31000000-0000-4000-8000-000000000003';
select tests.assert_true(
  tests.flagged(tests.first_occ('c-rev')) and tests.who(tests.first_occ('c-rev')) = '',
  'Finn leaves: the occurrence is in Needs assignment review');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_chore_volunteer_request(tests.i('v1'), tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), array[tests.i('m-dave-a')], false)),
  'A Member cannot ask for volunteers');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'invalid_recipient' from public.create_chore_volunteer_request(tests.i('v1'), tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), array[gen_random_uuid()], true)),
  'Only current members can be invited');
select tests.assert_true(
  (select outcome = 'preview' and deadline = ((tests.today_a() + 2)::timestamp at time zone 'Europe/Brussels')
   from public.create_chore_volunteer_request(tests.i('v1'), tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), array[tests.i('m-carol-a'), tests.i('m-dave-a'), tests.i('m-erin-a')], true)),
  'The preview gives the deadline: the end of the due day in the Home''s timezone');
select tests.assert_true(
  tests.sd($q$select count(*) = 0 from private.chore_volunteer_requests$q$), 'A preview sends nothing');
select tests.assert_true(
  (select outcome = 'sent' from public.create_chore_volunteer_request(tests.i('v1'), tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), array[tests.i('m-carol-a'), tests.i('m-dave-a'), tests.i('m-erin-a')], false)),
  'Alice invites Carol, Dave and Erin');
select tests.assert_true(
  (select outcome = 'exists' from public.create_chore_volunteer_request(tests.i('v1'), tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), array[tests.i('m-carol-a')], false)),
  'A retry answers exists');
select tests.assert_true(
  (select outcome = 'request_open' from public.create_chore_volunteer_request(tests.i('v2'), tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), array[tests.i('m-carol-a')], false)),
  'One open request per occurrence');
select tests.assert_true(
  tests.notices('carol', 'chore.volunteer_invited') = 1 and tests.notices('erin', 'chore.volunteer_invited') = 1,
  'Each invitee is told once');
select tests.assert_true(
  (select (s ->> 'awaitingVolunteer')::boolean and jsonb_array_length(s -> 'requests' -> 0 -> 'invitations') = 3
   from public.get_chore_volunteer_state(tests.first_occ('c-rev')) s),
  'Alice sees the request awaiting a volunteer, with all three invitations');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_pool(tests.i('home-a')) p where p.id = tests.first_occ('c-rev')),
  'It is not in the pool');

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 and bool_and(title = 'Recycling' and instructions = 'Rinse first' and minutes = 20
     and jsonb_array_length(steps) = 1 and due_date = tests.today_a() + 1)
   from public.list_chore_volunteer_offers(tests.i('home-a'))),
  'Carol''s offer shows the chore''s details');
select tests.assert_true(
  (select jsonb_array_length(s -> 'requests' -> 0 -> 'invitations') = 1
     and s -> 'requests' -> 0 -> 'invitations' -> 0 -> 'member' ->> 'me' = 'true'
     and s -> 'requests' -> 0 ->> 'by' is null and s ->> 'volunteer' is null
   from public.get_chore_volunteer_state(tests.first_occ('c-rev')) s),
  'She sees only her own invitation, not the roster or who asked');
select tests.assert_true(
  (select outcome = 'not_claimable' from public.claim_chore_occurrence(tests.first_occ('c-rev'))),
  'Awaiting a volunteer, it cannot be claimed');
select tests.assert_true(
  (select outcome = 'declined' from public.answer_chore_volunteer_invitation(tests.i('v1'), 'decline')),
  'Carol declines');
select tests.assert_true(
  (select outcome = 'declined' from public.answer_chore_volunteer_invitation(tests.i('v1'), 'decline')),
  'A retry answers declined again');
select tests.assert_true(
  (select outcome = 'not_open' and status = 'declined' from public.answer_chore_volunteer_invitation(tests.i('v1'), 'accept')),
  'She cannot accept after declining');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_invited' from public.answer_chore_volunteer_invitation(tests.i('v1'), 'accept')),
  'Bob was not invited');
select tests.act_as_user('31000000-0000-4000-8000-000000000002');
select tests.assert_denied(
  format($$select * from public.answer_chore_volunteer_invitation(%L, null)$$, tests.i('v1')),
  'An answer without an action is refused, never taken as acceptance', '22023');
select tests.assert_denied(
  format($$select * from public.change_chore_volunteer_request(%L, null, array[gen_random_uuid()])$$,
    tests.i('v1')),
  'A request change without an action is refused', '22023');
select tests.assert_true(
  (select outcome = 'accepted' from public.answer_chore_volunteer_invitation(tests.i('v1'), 'accept')),
  'Erin accepts first');
select tests.assert_true(
  tests.who(tests.first_occ('c-rev')) = 'erin' and not tests.flagged(tests.first_occ('c-rev')),
  'She is its only assignee and the review flag is gone');
select tests.assert_true(
  tests.request('v1') = 'accepted' and tests.invitations('v1') = 'carol:declined,dave:closed,erin:accepted',
  'The request is accepted; Dave''s invitation closed');
select tests.assert_true(tests.events(tests.first_occ('c-rev')) = 'volunteered', 'A volunteered event');
select tests.assert_true(tests.notices('alice', 'chore.volunteer_accepted') = 1, 'Alice is told');
select tests.act_as_user('31000000-0000-4000-8000-000000000001');
select tests.assert_true(
  (select outcome = 'not_open' and status = 'closed' from public.answer_chore_volunteer_invitation(tests.i('v1'), 'accept')),
  'Dave''s later acceptance is refused neutrally');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_volunteer_offers(tests.i('home-a'))), 'Nothing is offered to him any more');

-- Correction of the accepted volunteer -------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  format($$select * from public.correct_chore_volunteer_assignment(%L, %s, '  ', true)$$,
    tests.first_occ('c-rev'), tests.occ_rev(tests.first_occ('c-rev'))),
  'A correction needs a reason', '22023');
select tests.assert_true(
  (select outcome = 'preview' and volunteer_member = tests.i('m-erin-a') and not overdue
   from public.correct_chore_volunteer_assignment(tests.first_occ('c-rev'), tests.occ_rev(tests.first_occ('c-rev')),
    'Erin is ill', true, tests.i('m-dave-a'))),
  'The preview names the volunteer');
select tests.assert_true(
  (select outcome = 'corrected' from public.correct_chore_volunteer_assignment(tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), 'Erin is ill', false, tests.i('m-dave-a'))),
  'Alice gives it to Dave instead');
select tests.assert_true(
  tests.who(tests.first_occ('c-rev')) = 'dave' and tests.request('v1') = 'accepted'
  and tests.invitations('v1') = 'carol:declined,dave:closed,erin:accepted',
  'Dave is assigned; the accepted request and its invitations stay as they were');
select tests.assert_true(
  tests.events(tests.first_occ('c-rev')) = 'volunteered,assignment_corrected:Erin is ill', 'A distinct correction event');
select tests.assert_true(tests.notices('erin', 'chore.assignment_corrected') = 1, 'Erin is told');
select tests.assert_true(
  (select outcome = 'not_volunteered' from public.correct_chore_volunteer_assignment(tests.first_occ('c-rev'),
    tests.occ_rev(tests.first_occ('c-rev')), 'Again', true)),
  'Once corrected it is no longer a volunteer assignment');

-- Withdrawal, adding recipients, cancel, direct assignment ------------------------------------------------

select tests.act_as_owner();
update private.chore_occurrences set needs_reassignment = true where id = tests.first_occ('c-rev2');
delete from private.chore_occurrence_assignees where occurrence_id in (tests.first_occ('c-rev2'), tests.first_occ('c-rev3'));
update private.chore_occurrences set needs_reassignment = true where id = tests.first_occ('c-rev3');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'sent' from public.create_chore_volunteer_request(tests.i('v2'), tests.first_occ('c-rev2'),
    tests.occ_rev(tests.first_occ('c-rev2')), array[tests.i('m-carol-a'), tests.i('m-dave-a')], false)),
  'A request for the second chore');
select tests.assert_true(
  (select outcome = 'withdrawn' and not closed from public.change_chore_volunteer_request(tests.i('v2'), 'withdraw',
    array[tests.i('m-carol-a')])),
  'Alice withdraws Carol''s invitation; the request stays open');
select tests.assert_true(tests.invitations('v2') = 'carol:withdrawn,dave:pending', 'Carol''s reads withdrawn');
select tests.assert_true(
  (select outcome = 'added' and skipped = array[tests.i('m-carol-a')]
   from public.change_chore_volunteer_request(tests.i('v2'), 'add', array[tests.i('m-carol-a'), tests.i('m-erin-a')])),
  'Adding Carol again is skipped; Erin is added');
select tests.assert_true(tests.invitations('v2') = 'carol:withdrawn,dave:pending,erin:pending', 'Erin is pending now');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_open' and status = 'withdrawn' from public.answer_chore_volunteer_invitation(tests.i('v2'), 'accept')),
  'Carol cannot accept a withdrawn invitation');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'withdrawn' and closed from public.change_chore_volunteer_request(tests.i('v2'), 'withdraw',
    array[tests.i('m-dave-a'), tests.i('m-erin-a')])),
  'Withdrawing the last pending invitations closes the request');
select tests.assert_true(
  tests.request('v2') = 'closed' and tests.flagged(tests.first_occ('c-rev2')) and tests.who(tests.first_occ('c-rev2')) = '',
  'The occurrence stays in review, unassigned');
select tests.assert_true(
  (select outcome = 'not_open' from public.change_chore_volunteer_request(tests.i('v2'), 'add', array[tests.i('m-dave-a')])),
  'A closed request takes no new recipients');
select tests.assert_true(
  (select outcome = 'sent' from public.create_chore_volunteer_request(tests.i('v3'), tests.first_occ('c-rev2'),
    tests.occ_rev(tests.first_occ('c-rev2')), array[tests.i('m-dave-a')], false)),
  'A new request can be sent');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.first_occ('c-rev2'),
    tests.occ_rev(tests.first_occ('c-rev2')), false, p_assignee_ids => array[tests.i('m-carol-a')])),
  'Alice assigns Carol directly');
select tests.assert_true(
  tests.request('v3') = 'resolved' and tests.invitations('v3') = 'dave:closed',
  'That resolves the open request');
select tests.assert_true(
  (select outcome = 'sent' from public.create_chore_volunteer_request(tests.i('v4'), tests.first_occ('c-rev3'),
    tests.occ_rev(tests.first_occ('c-rev3')), array[tests.i('m-dave-a'), tests.i('m-erin-a')], false)),
  'A request for the third chore');
select tests.assert_true(
  (select outcome = 'cancelled' from public.change_chore_volunteer_request(tests.i('v4'), 'cancel')),
  'Alice cancels it');
select tests.assert_true(
  tests.request('v4') = 'cancelled' and tests.invitations('v4') = 'dave:closed,erin:closed',
  'Its invitations close');

-- Expiry at the deadline ----------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'sent' from public.create_chore_volunteer_request(tests.i('v5'), tests.first_occ('c-rev3'),
    tests.occ_rev(tests.first_occ('c-rev3')), array[tests.i('m-dave-a'), tests.i('m-erin-a')], false)),
  'Another request for the third chore');
select tests.act_as_owner();
-- As if two days passed: the due day is now yesterday, so the deadline has passed.
update private.chore_occurrences set due_date = tests.today_a() - 1 where id = tests.first_occ('c-rev3');
select tests.assert_true(
  tests.request('v5') = 'expired' and tests.invitations('v5') = 'dave:expired,erin:expired',
  'A due date moved into the past expires the request and its invitations');
select tests.act_as_user('31000000-0000-4000-8000-000000000001');
select tests.assert_true(
  (select outcome = 'expired' from public.answer_chore_volunteer_invitation(tests.i('v5'), 'accept')),
  'An acceptance after the deadline is refused');
select tests.assert_true(tests.who(tests.first_occ('c-rev3')) = '', 'Nobody is assigned');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deadline_passed' from public.create_chore_volunteer_request(gen_random_uuid(), tests.first_occ('c-rev3'),
    tests.occ_rev(tests.first_occ('c-rev3')), array[tests.i('m-dave-a')], false)),
  'With the overdue due date unchanged, no new request can be sent');
select tests.assert_true(
  (select not (s ->> 'canRequest')::boolean and r ->> 'status' = 'expired' and not (r ->> 'canChange')::boolean
   from public.get_chore_volunteer_state(tests.first_occ('c-rev3')) s, jsonb_array_elements(s -> 'requests') r
   where r ->> 'id' = tests.i('v5')::text),
  'The expired request cannot be changed or reopened');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.first_occ('c-rev3'),
    tests.occ_rev(tests.first_occ('c-rev3')), false, p_due_date => tests.today_a() + 5)),
  'A new future due date');
select tests.assert_true(
  tests.request('v5') = 'expired' and tests.sd($q$select count(*) = 0 from private.chore_volunteer_requests
    where occurrence_id = tests.first_occ('c-rev3') and status = 'open'$q$),
  'The date change alone sends nothing and reopens nothing');
select tests.assert_true(
  (select (s ->> 'canRequest')::boolean from public.get_chore_volunteer_state(tests.first_occ('c-rev3')) s),
  'A fresh request can be sent now');

-- Lazy expiry and departure of the last invitee -----------------------------------------------------------

select tests.assert_true(
  (select outcome = 'sent' from public.create_chore_volunteer_request(gen_random_uuid(), tests.first_occ('c-rev3'),
    tests.occ_rev(tests.first_occ('c-rev3')), array[tests.i('m-erin-a')], false)),
  'A request to Erin only');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = '31000000-0000-4000-8000-000000000002';
select tests.assert_true(
  (select count(*) filter (where status = 'open') = 0 and count(*) filter (where status = 'closed') = 1
   from private.chore_volunteer_requests where occurrence_id = tests.first_occ('c-rev3')),
  'When Erin, the only invitee, leaves, the request closes');
select tests.assert_true(
  tests.flagged(tests.first_occ('c-rev3')) and tests.who(tests.first_occ('c-rev3')) = '', 'The occurrence stays in review');

-- Departure withdraws pending proposals ---------------------------------------------------------------------

delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.assert_true(tests.proposal('p5') = 'withdrawn', 'When Carol leaves, her waiting proposal is withdrawn');

-- Audit --------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select count(distinct action) >= 6 from private.audit_events where home_id = tests.i('home-a')
     and action in ('chore_proposal.submitted', 'chore_proposal.approved', 'chore_proposal.rejected',
       'chore_proposal.withdrawn', 'chore_volunteer_request.sent', 'chore_volunteer_request.accepted',
       'chore_occurrence.assignment_corrected')),
  'Proposals, requests and corrections are audited');
select tests.assert_true(
  not exists (select 1 from private.audit_events where home_id = tests.i('home-a')
    and (details::text like '%garage%' or details::text like '%Recycling%' or details::text like '%ill%')),
  'Without titles or reasons');
