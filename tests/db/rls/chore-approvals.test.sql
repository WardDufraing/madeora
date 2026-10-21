-- S20: chore approval, rework and correction (supabase/migrations/*_chores.sql). Alice owns Home A,
-- where Bob is an Administrator (granted manageHomeChores, later approveHomeChores) and Carol a
-- Member; Bob owns Home B. Covers: approval off by default and turned on per chore by a
-- chore manager; a member's completion becomes a submission (Pending approval) and notifies the
-- current reviewers but not the submitter, once per non-empty queue; ordinary and chore-manager
-- rights never review; no ticking, completing again or skipping while pending; rejection needs a
-- reason and a fresh revision, leaves Needs rework with the attempt kept; resubmission is a new
-- attempt that needs the mandatory steps again; approval completes with the submission's people and
-- time; self-approval is permitted and labelled; a departed contributor blocks approval; the review
-- queue for reviewers only; reopening a pending submission withdraws it; turning approval off keeps
-- what waits; corrections by chore managers keep the values before; history states; isolation.

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
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m,
  unnest(array['alice', 'bob', 'carol']) u
  where m.home_id = (select id from ids where name = 'home-a') and m.user_id = tests.user_id(u);
insert into ids select 'm-bob-b', m.id from public.home_memberships m
  where m.home_id = (select id from ids where name = 'home-b') and m.user_id = tests.user_id('bob');
insert into ids select n, gen_random_uuid() from unnest(array['c-bins', 'c-self', 'c-left', 'c-b']) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.occ(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) order by scheduled_date limit 1; $$;
create function tests.orev(p_chore text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_occurrences where id = tests.occ(p_chore); $$;
create function tests.crev(p_chore text) returns integer
  language sql stable security definer as $$ select revision from private.chores where id = tests.i(p_chore); $$;
create function tests.ostate(p_chore text) returns text
  language sql stable security definer as $$
  select status || case when in_rework then '+rework' else '' end from private.chore_occurrences
  where id = tests.occ(p_chore); $$;
create function tests.step(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrence_steps where occurrence_id = tests.occ(p_chore) order by position limit 1; $$;
create function tests.approval_notices(p_user text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications where user_id = tests.user_id(p_user)
    and kind = 'chore.approval_requested'; $$;
create function tests.events(p_chore text) returns text
  language sql stable security definer as $$
  select string_agg(kind, ',' order by id) from private.chore_occurrence_events
  where occurrence_id = tests.occ(p_chore); $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable, and the setting ----------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied('select * from private.chore_submissions', 'The API cannot read submissions');
select tests.assert_denied(
  $$select private.notify_chore_reviewers(gen_random_uuid(), null)$$, 'Nor notify reviewers itself');

select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeChores']) = 'ok',
  'The Owner makes Bob a chore manager (not a reviewer)');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-bins'), tests.i('home-a'), 'Bins',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    '[{"label": "Sort", "mandatory": true}]', p_due_date => tests.today_a())),
  'A one-off chore for Carol with a required step');
select tests.assert_true(
  (select not (o -> 'chore' ->> 'requiresApproval')::boolean from public.get_chore_occurrence(tests.occ('c-bins')) o),
  'Approval is off unless turned on');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_chore(tests.i('c-bins'), tests.crev('c-bins'), 'Bins',
    p_requires_approval => true)),
  'A Member cannot turn approval on');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore(tests.i('c-bins'), tests.crev('c-bins'), 'Bins',
    p_requires_approval => true)),
  'A chore manager turns approval on for this chore');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore(tests.i('c-bins'), tests.crev('c-bins'), 'Bins')),
  'Saving the other fields keeps it on');

-- Submitting ----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'steps_incomplete' from public.complete_chore_occurrence(tests.occ('c-bins'), tests.i('m-carol-a'))),
  'Required steps come first, also for a submission');
select public.set_chore_step(tests.step('c-bins'), true);
select tests.assert_true(
  (select outcome = 'submitted' and contributor_me from public.complete_chore_occurrence(
    tests.occ('c-bins'), tests.i('m-carol-a'), 'All sorted')),
  'Carol completes it: it is submitted, not completed');
select tests.assert_true(tests.ostate('c-bins') = 'pending_approval', 'The occurrence is Pending approval');
select tests.assert_true(
  (select o -> 'completion' = 'null'::jsonb and o -> 'submissions' -> 0 ->> 'status' = 'pending'
     and o -> 'submissions' -> 0 ->> 'note' = 'All sorted'
     and (o -> 'submissions' -> 0 -> 'steps' -> 0 ->> 'checked')::boolean
     and not (o -> 'can' ->> 'complete')::boolean and not (o -> 'can' ->> 'review')::boolean
   from public.get_chore_occurrence(tests.occ('c-bins')) o),
  'Carol sees her pending attempt with its note and checklist, and cannot review it');
select tests.assert_true(
  (select outcome = 'already_submitted' and completed_by_me from public.complete_chore_occurrence(
    tests.occ('c-bins'), tests.i('m-carol-a'))),
  'Completing again is told a submission waits');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.set_chore_step(tests.step('c-bins'), false)),
  'The checklist is part of the submission while it waits');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.chore_submissions where occurrence_id = tests.occ('c-bins')),
  'One submission, whatever the retries');
select tests.assert_true(tests.approval_notices('alice') = 1, 'The Owner (a reviewer) is notified in-app');
select tests.assert_true(
  (select email_status = 'none' and show_in_app and params = jsonb_build_object('homeId', tests.i('home-a'))
   from public.notifications where user_id = tests.user_id('alice') and kind = 'chore.approval_requested'),
  'In-app only by default (email is opt-in), naming no chore or person');
select tests.assert_true(
  tests.approval_notices('bob') = 0 and tests.approval_notices('carol') = 0,
  'Members and chore managers without approval rights are not notified');

-- Who reviews ----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.review_chore_submission(tests.occ('c-bins'), tests.orev('c-bins'), 'approve')),
  'Ordinary completion rights never review');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_approvals(tests.i('home-a'))),
  'A Member gets no review queue');
select tests.assert_true(
  (select not can_review and pending_count = 0 from public.get_chore_context(tests.i('home-a'))),
  'Nor a pending count');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.review_chore_submission(tests.occ('c-bins'), tests.orev('c-bins'), 'approve')),
  'Managing chores is not approving them');
select tests.assert_true(
  (select outcome = 'pending_approval' from public.skip_chore_occurrence(tests.occ('c-bins'))),
  'A waiting submission is not skipped');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.update_chore_occurrence(tests.occ('c-bins'),
    tests.orev('c-bins'), p_due_date => tests.today_a() + 1, p_dry_run => true)),
  'Nor changed');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 and bool_and(attempt = 1 and contributor_member = tests.i('m-carol-a')
     and submitted_by_member = tests.i('m-carol-a') and contributor_current and note = 'All sorted'
     and steps_done = 1 and steps_total = 1 and not late)
   from public.list_chore_approvals(tests.i('home-a'))),
  'The Owner''s queue shows the attempt with its people, note and checklist');
select tests.assert_true(
  (select can_review and pending_count = 1 from public.get_chore_context(tests.i('home-a'))),
  'And counts it');

-- Rejecting and rework --------------------------------------------------------------------------------------

select tests.assert_denied(
  format($$select * from public.review_chore_submission(%L, %s, 'reject')$$, tests.occ('c-bins'), tests.orev('c-bins')),
  'Rejecting needs a reason', '22023');
select tests.assert_denied(
  format($$select * from public.review_chore_submission(%L, %s, 'reject', '   ')$$, tests.occ('c-bins'), tests.orev('c-bins')),
  'A blank reason is no reason', '22023');
select tests.assert_true(
  (select outcome = 'conflict' from public.review_chore_submission(tests.occ('c-bins'), tests.orev('c-bins') - 1,
    'reject', 'Glass left')),
  'A decision on a stale view is refused');
select tests.assert_true(
  (select outcome = 'rejected' and status = 'open' from public.review_chore_submission(tests.occ('c-bins'),
    tests.orev('c-bins'), 'reject', '  Glass   left ')),
  'The Owner rejects it with a reason');
select tests.assert_true(tests.ostate('c-bins') = 'open+rework', 'It Needs rework');
select tests.assert_true(
  (select outcome = 'not_pending' and status = 'open' from public.review_chore_submission(tests.occ('c-bins'),
    tests.orev('c-bins'), 'approve')),
  'A second decision finds nothing pending');
select tests.act_as('carol');
select tests.assert_true(
  (select (o ->> 'inRework')::boolean and o -> 'submissions' -> 0 ->> 'status' = 'rejected'
     and o -> 'submissions' -> 0 ->> 'reason' = 'Glass left'
     and o -> 'assignees' = jsonb_build_array(tests.i('m-carol-a'))
     and (o -> 'can' ->> 'complete')::boolean
   from public.get_chore_occurrence(tests.occ('c-bins')) o),
  'Carol sees the reason, stays assigned and may resubmit');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_step(tests.step('c-bins'), false)),
  'She may redo the checklist');
select tests.assert_true(
  (select outcome = 'steps_incomplete' from public.complete_chore_occurrence(tests.occ('c-bins'), tests.i('m-carol-a'))),
  'A resubmission needs the required steps again');
select public.set_chore_step(tests.step('c-bins'), true);
select tests.assert_true(
  (select outcome = 'submitted' from public.complete_chore_occurrence(tests.occ('c-bins'), tests.i('m-bob-a'),
    'Glass too')),
  'She resubmits, naming Bob as who did it');
select tests.act_as_owner();
select tests.assert_true(
  (select array_agg(attempt || ':' || status order by attempt) = array['1:rejected', '2:pending']
   from private.chore_submissions where occurrence_id = tests.occ('c-bins')),
  'The rejected attempt stays; the resubmission is attempt 2');
select tests.assert_true(tests.approval_notices('alice') = 2,
  'The queue had emptied, so the Owner is notified again');

-- Approving -------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  format($$select * from public.review_chore_submission(%L, %s, 'approve', 'Fine')$$, tests.occ('c-bins'), tests.orev('c-bins')),
  'Approving takes no reason', '22023');
select tests.assert_true(
  (select outcome = 'approved' and status = 'completed' from public.review_chore_submission(tests.occ('c-bins'),
    tests.orev('c-bins'), 'approve')),
  'The Owner approves attempt 2');
select tests.act_as('carol');
select tests.assert_true(
  (select (o -> 'completion' -> 'contributor' ->> 'member')::uuid = tests.i('m-bob-a')
     and (o -> 'completion' -> 'by' ->> 'me')::boolean
     and (o -> 'completion' -> 'approvedBy' ->> 'member')::uuid = tests.i('m-alice-a')
     and o -> 'completion' ->> 'note' = 'Glass too'
     and (o -> 'completion' ->> 'at')::timestamptz = (o -> 'submissions' -> 0 ->> 'at')::timestamptz
     and not (o -> 'submissions' -> 0 ->> 'selfApproved')::boolean
   from public.get_chore_occurrence(tests.occ('c-bins')) o),
  'Completed with the submission''s contributor, submitter, reported time and note, approved by the Owner');
select tests.assert_true(
  tests.events('c-bins') = 'submitted,rejected,submitted,approved', 'Every step is an event');

-- Self-approval ---------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'),
    array['manageHomeChores', 'approveHomeChores']) = 'ok',
  'The Owner makes Bob a reviewer too');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-self'), tests.i('home-a'), 'Windows',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a(), p_requires_approval => true)),
  'A chore created with approval on');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'submitted' from public.complete_chore_occurrence(tests.occ('c-self'), tests.i('m-bob-a'))),
  'Bob submits his own work');
select tests.act_as_owner();
select tests.assert_true(tests.approval_notices('bob') = 0, 'The submitter is not notified of his own submission');
select tests.assert_true(tests.approval_notices('alice') = 3, 'The other reviewer is');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'approved' from public.review_chore_submission(tests.occ('c-self'), tests.orev('c-self'), 'approve')),
  'A reviewer may approve his own completion');
select tests.assert_true(
  (select (o -> 'submissions' -> 0 ->> 'selfApproved')::boolean from public.get_chore_occurrence(tests.occ('c-self')) o),
  'It is labelled self-approved');
select tests.act_as_owner();
select tests.assert_true(
  (select details ->> 'selfApproved' = 'true' from private.audit_events
   where action = 'chore_occurrence.approved' and subject_id = tests.occ('c-self')),
  'And audited as such');

-- Grouping, withdrawal, approval turned off, a departed contributor ----------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-left'), tests.i('home-a'), 'Garage',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a(), p_requires_approval => true)),
  'Another chore with approval');
select tests.act_as('carol');
select public.complete_chore_occurrence(tests.occ('c-left'), tests.i('m-carol-a'));
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'reopened' from public.reopen_chore_occurrence(tests.occ('c-self'))),
  'A chore manager reopens a completed occurrence');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'submitted' from public.complete_chore_occurrence(tests.occ('c-self'), tests.i('m-carol-a'))),
  'Carol submits it');
select tests.act_as_owner();
select tests.assert_true(tests.approval_notices('alice') = 4 and tests.approval_notices('bob') = 1,
  'Two submissions while the queue was not empty notify each reviewer once');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore(tests.i('c-self'), tests.crev('c-self'), 'Windows',
    p_requires_approval => false)),
  'Approval turned off for Windows');
select tests.assert_true(tests.ostate('c-self') = 'pending_approval', 'What waits stays pending');
select tests.assert_true(
  (select outcome = 'reopened' from public.reopen_chore_occurrence(tests.occ('c-self'))),
  'A chore manager withdraws it by reopening');
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'withdrawn' from private.chore_submissions where occurrence_id = tests.occ('c-self') and attempt = 2),
  'The attempt is kept as withdrawn');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'completed' from public.complete_chore_occurrence(tests.occ('c-self'), tests.i('m-carol-a'))),
  'With approval off, the next completion is final');

-- Corrections -----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.correct_chore_completion(tests.occ('c-bins'), tests.orev('c-bins'),
    tests.i('m-carol-a'))),
  'A Member cannot correct a completion');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_completed' from public.correct_chore_completion(tests.occ('c-left'), tests.orev('c-left'),
    tests.i('m-carol-a'))),
  'Only a completed occurrence is corrected (this one waits)');
select tests.assert_true(
  (select outcome = 'unchanged' from public.correct_chore_completion(tests.occ('c-bins'), tests.orev('c-bins'))),
  'Nothing to change changes nothing');
select tests.assert_denied(
  format($$select * from public.correct_chore_completion(%L, %s, p_completed_at => now() + interval '1 day')$$,
    tests.occ('c-bins'), tests.orev('c-bins')),
  'A completion is never in the future', '22023');
select tests.assert_true(
  (select outcome = 'invalid_contributor' from public.correct_chore_completion(tests.occ('c-bins'), tests.orev('c-bins'),
    tests.i('m-bob-b'))),
  'Another Home''s member is refused');
select tests.assert_true(
  (select outcome = 'conflict' from public.correct_chore_completion(tests.occ('c-bins'), tests.orev('c-bins') - 1,
    tests.i('m-carol-a'))),
  'A stale correction is refused');
select tests.assert_true(
  (select outcome = 'corrected' from public.correct_chore_completion(tests.occ('c-bins'), tests.orev('c-bins'),
    tests.i('m-carol-a'), now() - interval '2 hours', true, null, 'Carol did it')),
  'The Owner corrects who did it, when, and clears the note');
select tests.assert_true(
  (select (o -> 'completion' -> 'contributor' ->> 'member')::uuid = tests.i('m-carol-a')
     and o -> 'completion' ->> 'note' is null
     and o -> 'events' -> -1 ->> 'kind' = 'corrected'
     and o -> 'events' -> -1 ->> 'previousNote' = 'Glass too'
     and (o -> 'events' -> -1 -> 'previousContributor' ->> 'member')::uuid = tests.i('m-bob-a')
     and o -> 'events' -> -1 ->> 'reason' = 'Carol did it'
   from public.get_chore_occurrence(tests.occ('c-bins')) o),
  'The record shows the correction; the event keeps what was there');

-- History, isolation -------------------------------------------------------------------------------------

select tests.assert_true(
  (select status = 'completed' and approved_by_member = tests.i('m-alice-a') and attempts = 2
   from public.list_chore_history(tests.i('c-bins'))),
  'The chore''s history shows the approver and the attempts');
select tests.assert_true(
  (select status = 'pending_approval' from public.list_chore_history(tests.i('c-left'), 'pending_approval')),
  'And Pending approval as its own state');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-b'), tests.i('home-b'), 'B chore',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a(), p_requires_approval => true)),
  'Bob has a chore with approval in Home B');
select public.complete_chore_occurrence(tests.occ('c-b'), tests.i('m-bob-b'));
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_found' from public.review_chore_submission(tests.occ('c-b'), tests.orev('c-b'), 'approve')),
  'The Owner of Home A cannot review Home B''s submissions');
select tests.assert_denied(
  format($$select * from public.list_chore_approvals(%L)$$, tests.i('home-b')),
  'Nor read its queue');
select tests.assert_true(
  public.set_notification_preference('approvals', 'email', true, tests.i('home-a')) = 'ok',
  'Reviewers may opt in to approval emails');

-- A departed contributor ----------------------------------------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.act_as('alice');
select tests.assert_true(
  (select not contributor_current from public.list_chore_approvals(tests.i('home-a'))
   where occurrence_id = tests.occ('c-left')),
  'The queue shows the contributor left');
select tests.assert_true(
  (select outcome = 'contributor_unavailable' from public.review_chore_submission(tests.occ('c-left'),
    tests.orev('c-left'), 'approve')),
  'A contributor who left cannot be approved');
select tests.assert_true(
  (select outcome = 'rejected' from public.review_chore_submission(tests.occ('c-left'), tests.orev('c-left'),
    'reject', 'Carol left')),
  'It can still be rejected');
select tests.assert_true(
  (select status = 'rework' from public.list_chore_history(tests.i('c-left'), 'rework')),
  'Needs rework is its own history state');
