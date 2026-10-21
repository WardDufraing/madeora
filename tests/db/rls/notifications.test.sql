-- S14: notifications (supabase/migrations/*_notifications.sql). Covers the in-app store and its
-- RLS, global defaults with per-Home overrides, quiet hours, delivery and email queuing, the
-- ownership-recovery and join-request triggers, the invitation email jobs and the service-role
-- functions the jobs use.
--
-- Home A (Europe/Brussels): Alice owns it; Dave is an Administrator and Erin a Member (both for 40
-- days). Home B (America/New_York): Bob owns it; Carol and Gina are members. Carol is also a member
-- of Home A. Hank has no Home. Ivy has not confirmed her email.
-- The whole file is one transaction, so now() does not move: quiet hours are checked at explicit
-- instants, and the one delivery test builds a window around now().

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;
create temporary table keep (name text primary key, value text) on commit drop;
grant all on keep to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'dave@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'erin@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'gina@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'hank@madeora.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000005',
   'authenticated', 'authenticated', 'ivy@madeora.test', null, now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Elders', 'America/New_York', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role, created_at) values
  ((select id from ids where name = 'home-a'), tests.user_id('dave'), 'administrator', now() - interval '40 days'),
  ((select id from ids where name = 'home-a'), tests.user_id('erin'), 'member', now() - interval '40 days'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member', now() - interval '40 days'),
  ((select id from ids where name = 'home-b'), tests.user_id('carol'), 'member', now() - interval '40 days'),
  ((select id from ids where name = 'home-b'), tests.user_id('gina'), 'member', now() - interval '40 days');
-- Nobody has signed in since before the requests below.
update auth.users set last_sign_in_at = now() - interval '60 days'
  where email in ('alice@madeora.test', 'bob@madeora.test');

-- Out of the API's reach -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied(
  $$insert into public.notifications (user_id, category, kind, dedupe_key, show_in_app, correlation_id)
    values (tests.user_id('carol'), 'security', 'a.b', 'x', true, gen_random_uuid())$$,
  'Nobody writes a notification through the API'
);
select tests.assert_denied($$update public.notifications set read_at = now()$$,
  'Nobody updates a notification directly (marking read goes through the function)');
select tests.assert_denied($$delete from public.notifications$$, 'Nobody deletes a notification directly');
select tests.assert_denied($$select email_status from public.notifications$$,
  'The email state and error code are not readable through the API');
select tests.assert_denied($$select correlation_id from public.notifications$$,
  'Neither is the correlation id');
select tests.assert_denied(
  $$insert into public.notification_preferences (category, channel, enabled)
    values ('invitations', 'email', true)$$,
  'Preferences are written only through the functions'
);
select tests.assert_denied(
  $$insert into public.notification_quiet_hours (enabled, start_time, end_time, time_zone)
    values (true, '22:00', '07:00', 'UTC')$$,
  'Quiet hours are written only through the function'
);
select tests.act_as_anon();
select tests.assert_denied($$select id from public.notifications$$, 'Visitors read no notifications');
select tests.assert_denied($$select * from public.get_notification_settings()$$, 'Visitors have no settings');

select tests.act_as_owner();
select tests.assert_true(
  not exists (
    select 1
    from (values
      ('private.notify_user(uuid,uuid,text,text,jsonb,text,boolean)'),
      ('private.effective_notification_channel(uuid,uuid,text,text)'),
      ('private.notification_quiet_state(uuid,uuid,timestamptz)'),
      ('public.deliver_recovery_ready(uuid,timestamptz)'),
      ('public.get_invitation_email(uuid,integer)'),
      ('public.record_invitation_email(uuid,integer,text)'),
      ('public.get_notification_email(uuid)'),
      ('public.record_notification_email(uuid,text,text)')
    ) f(signature),
    (values ('anon'), ('authenticated')) r(role_name)
    where has_function_privilege(r.role_name, f.signature, 'execute')
  ),
  'anon and authenticated can neither deliver nor run any job function'
);
select tests.assert_true(
  has_function_privilege('service_role', 'public.get_notification_email(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.get_invitation_email(uuid,integer)', 'execute')
    and has_function_privilege('service_role', 'public.deliver_recovery_ready(uuid,timestamptz)', 'execute')
    and not has_function_privilege('service_role', 'private.notify_user(uuid,uuid,text,text,jsonb,text,boolean)', 'execute'),
  'The service role runs the job functions and cannot deliver notifications itself'
);
select tests.assert_true(
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('public.notifications'::regclass, 'public.notification_preferences'::regclass,
                   'public.notification_quiet_hours'::regclass)),
  'All three notification tables have row level security'
);

-- Delivery and the in-app store -------------------------------------------------------------------------

select tests.act_as_owner();
insert into ids select 'n1', private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-a'),
  'invitations', 'join_request.received', '{"requestId": "00000000-0000-4000-8000-000000000001"}', 'test:1', true);
select tests.assert_true((select id from ids where name = 'n1') is not null,
  'An optional notice is delivered in-app by default');
select tests.assert_true(
  (select show_in_app and email_status = 'none' and not during_quiet_hours from public.notifications
   where id = (select id from ids where name = 'n1')),
  'It is shown in-app, and email stays off until the person opts in'
);
select tests.assert_row_count(
  $$select 1 from private.job_outbox where job_name = 'notification-email'$$, 0,
  'No email job exists for it'
);
select tests.assert_true(
  private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-a'),
    'invitations', 'join_request.received', '{}', 'test:1', true) is null,
  'The same event is not delivered twice (dedupe key)'
);

select tests.act_as('carol');
select tests.assert_row_count($$select id from public.notifications$$, 1, 'Carol sees her notification');
select tests.assert_true(
  (select home_id = (select id from ids where name = 'home-a') and read_at is null
     and kind = 'join_request.received' from public.notifications),
  'with its source Home and unread'
);
select tests.act_as('bob');
select tests.assert_row_count($$select id from public.notifications$$, 0, 'Bob cannot see Carol''s notification');
select tests.act_as('alice');
select tests.assert_row_count($$select id from public.notifications$$, 0,
  'Not even the Owner of the Home sees another member''s notification');

select tests.act_as_owner();
select tests.assert_denied(
  $$select private.notify_user(tests.user_id('carol'), null, 'chores', 'a.b', '{}', 'test:bad')$$,
  'An unknown category is refused', '22023'
);
select tests.assert_true(
  private.notify_user(tests.user_id('ivy'), null, 'security', 'a.b', '{}', 'test:ivy', true) is null,
  'An account that has not confirmed its email receives nothing'
);
select tests.assert_true(
  private.notify_user(tests.user_id('bob'), (select id from ids where name = 'home-a'),
    'invitations', 'a.b', '{}', 'test:outsider') is null,
  'A Home notice goes only to a current member of that Home'
);

-- Global defaults and Home overrides ------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 18 and bool_and(not overridden)
     and bool_and(enabled = (channel = 'in_app'))
     and count(distinct category) = 3
   from public.get_notification_settings()),
  'By default nothing is overridden: in-app on, email off, for the three optional categories (S19b: reminders, S20: approvals), the account and both of her Homes'
);
select tests.assert_true(
  public.set_notification_preference('invitations', 'email', true, null) = 'ok',
  'Carol turns invitation email on for her account'
);
select tests.assert_true(
  (select bool_and(enabled) from (select * from public.get_notification_settings() where category = 'invitations') s
   where channel = 'email')
  and (select bool_and(not overridden) from (select * from public.get_notification_settings() where category = 'invitations') s
       where home_id is not null),
  'Both Homes inherit it, and show as inherited'
);
select tests.assert_true(
  public.set_notification_preference('invitations', 'email', false, (select id from ids where name = 'home-b')) = 'ok',
  'She overrides it for Home B only'
);
select tests.assert_true(
  (select enabled and not overridden from (select * from public.get_notification_settings() where category = 'invitations') s
   where home_id = (select id from ids where name = 'home-a') and channel = 'email')
  and (select not enabled and overridden from (select * from public.get_notification_settings() where category = 'invitations') s
       where home_id = (select id from ids where name = 'home-b') and channel = 'email'),
  'Home A still inherits the account choice; Home B shows as overridden'
);
select tests.assert_true(
  public.set_notification_preference('invitations', 'email', false, null) = 'ok'
  and (select not enabled and overridden from (select * from public.get_notification_settings() where category = 'invitations') s
       where home_id = (select id from ids where name = 'home-b') and channel = 'email'),
  'Changing the account default reaches the inheriting Home and never overwrites the override'
);
select tests.assert_true(
  public.set_notification_preference('invitations', 'email', true, null) = 'ok', 'Back on for the account');
select tests.assert_true(
  public.set_notification_preference('invitations', 'in_app', false, (select id from ids where name = 'home-a')) = 'ok',
  'Carol mutes in-app invitation notices in Home A'
);

select tests.act_as_owner();
-- Home A: in-app muted, email inherited (on). Email without in-app is a real choice.
insert into ids select 'n2', private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-a'),
  'invitations', 'join_request.received', '{}', 'test:2', true);
select tests.assert_true(
  (select not show_in_app and email_status = 'queued' from public.notifications
   where id = (select id from ids where name = 'n2')),
  'With in-app off and email on, the notice is kept for email only'
);
select tests.assert_row_count(
  $$select 1 from private.job_outbox o where o.job_name = 'notification-email'
      and o.idempotency_key = 'notification-email:' || (select id::text from ids where name = 'n2')
      and o.payload = jsonb_build_object('notificationId', (select id from ids where name = 'n2'))$$,
  1, 'One email job was queued in the same transaction, with the notification id as its only payload'
);
-- Home B: email overridden off, in-app inherited on.
insert into ids select 'n3', private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-b'),
  'invitations', 'join_request.received', '{}', 'test:3', true);
select tests.assert_true(
  (select show_in_app and email_status = 'none' from public.notifications
   where id = (select id from ids where name = 'n3')),
  'Home B: in-app on (inherited), email off (overridden)'
);
-- A notice from one Home never follows another Home's overrides.
select tests.act_as('carol');
select tests.assert_row_count($$select id from public.notifications$$, 2,
  'Home A''s muted notice is not listed; the other two are');
select tests.act_as_owner();
-- Everything off: nothing is stored at all.
select tests.act_as('carol');
select tests.assert_true(public.set_notification_preference('invitations', 'in_app', false, null) = 'ok'
  and public.set_notification_preference('invitations', 'email', false, null) = 'ok'
  and public.set_notification_preference('invitations', 'in_app', false, (select id from ids where name = 'home-b')) = 'ok',
  'Carol turns both channels off');
select tests.act_as_owner();
select tests.assert_true(
  private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-b'),
    'invitations', 'join_request.received', '{}', 'test:4', true) is null
  and private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-a'),
    'invitations', 'join_request.received', '{}', 'test:5', true) is null,
  'With every channel off an optional notice is not stored'
);
-- Essential notices ignore the mutes.
insert into ids select 'n4', private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-b'),
  'security', 'recovery.member_requested', '{}', 'test:6');
insert into ids select 'n5', private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-b'),
  'security', 'recovery.claimant_approved', '{}', 'test:7', true);
select tests.assert_true(
  (select show_in_app from public.notifications where id = (select id from ids where name = 'n4'))
  and (select show_in_app and email_status = 'queued' from public.notifications
       where id = (select id from ids where name = 'n5')),
  'Essential security notices are delivered in-app and by email despite every mute'
);

select tests.act_as('carol');
select tests.assert_denied($$select public.set_notification_preference('security', 'email', false, null)$$,
  'Essential notices cannot be configured', '22023');
select tests.assert_denied($$select public.set_notification_preference('invitations', 'sms', true, null)$$,
  'Only supported channels', '22023');
select tests.assert_true(
  public.set_notification_preference('invitations', 'email', true, gen_random_uuid()) = 'not_found',
  'A Home she does not belong to cannot be configured');
select tests.act_as('bob');
select tests.assert_true(
  public.set_notification_preference('invitations', 'email', true, (select id from ids where name = 'home-a')) = 'not_found',
  'Bob cannot set an override for Carol''s other Home');
select tests.act_as('carol');
select tests.assert_true(
  public.reset_notification_preference('invitations', 'in_app', (select id from ids where name = 'home-b')),
  'Reset removes the Home override, so the Home inherits the account choice (now off)');
select tests.assert_true(
  (select not enabled and not overridden from (select * from public.get_notification_settings() where category = 'invitations') s
   where home_id = (select id from ids where name = 'home-b') and channel = 'in_app'),
  'and says so');
select tests.assert_true(public.reset_notification_preference('invitations', 'in_app', null),
  'Carol resets the account choice');
select tests.assert_true(
  (select enabled and not overridden from (select * from public.get_notification_settings() where category = 'invitations') s
   where home_id is null and channel = 'in_app'),
  'which returns to the built-in default (in-app on)');
-- Bob's choices are his own.
select tests.act_as('bob');
select tests.assert_true(
  (select bool_and(not overridden) from (select * from public.get_notification_settings() where category = 'invitations') s),
  'Carol''s choices do not appear in Bob''s settings');
select tests.assert_row_count($$select id from public.notification_preferences$$, 0,
  'and Bob reads none of her stored preferences');

-- Quiet hours -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied(
  $$select public.set_notification_quiet_hours(true, '22:00', '22:00', 'Europe/Brussels', null)$$,
  'A window needs different start and end', '22023');
select tests.assert_denied(
  $$select public.set_notification_quiet_hours(true, '22:00', '07:00', 'Mars/Olympus', null)$$,
  'The zone must exist', '22023');
select tests.assert_true(
  public.set_notification_quiet_hours(true, '22:00', '07:00', 'Europe/Brussels', null) = 'ok',
  'Carol sets overnight quiet hours for her account');
select tests.assert_true(
  public.set_notification_quiet_hours(true, '23:00', '05:00', 'America/New_York', (select id from ids where name = 'home-b')) = 'ok',
  'and different ones for Home B in its own zone');
select tests.assert_true(
  public.set_notification_quiet_hours(false, '22:00', '07:00', 'Europe/Brussels', (select id from ids where name = 'home-a')) = 'ok',
  'and switches them off for Home A with an explicit override');
select tests.assert_true(
  public.reset_notification_quiet_hours((select id from ids where name = 'home-a')),
  'Resetting Home A returns it to the account''s quiet hours');

select tests.act_as_owner();
select tests.assert_true(
  (select not quiet from private.notification_quiet_state(tests.user_id('carol'),
     (select id from ids where name = 'home-a'), '2026-10-15 19:59:00+00'))
  and (select quiet and ends_at = '2026-10-16 05:00:00+00' from private.notification_quiet_state(
     tests.user_id('carol'), (select id from ids where name = 'home-a'), '2026-10-15 20:00:00+00')),
  'Overnight window in Brussels: 21:59 is outside, 22:00 starts it and it ends at 07:00 next morning');
select tests.assert_true(
  (select quiet and ends_at = '2026-10-15 05:00:00+00' from private.notification_quiet_state(
     tests.user_id('carol'), (select id from ids where name = 'home-a'), '2026-10-15 01:00:00+00'))
  and (select not quiet from private.notification_quiet_state(tests.user_id('carol'),
     (select id from ids where name = 'home-a'), '2026-10-15 05:00:00+00')),
  'After midnight the window ends the same morning, and 07:00 itself is outside');
select tests.assert_true(
  (select quiet and ends_at = '2026-10-25 06:00:00+00' from private.notification_quiet_state(
     tests.user_id('carol'), (select id from ids where name = 'home-a'), '2026-10-25 00:30:00+00')),
  'On the night the clocks go back (25 October) the window still ends at 07:00 local time (06:00 UTC)');
select tests.assert_true(
  (select quiet from private.notification_quiet_state(tests.user_id('carol'),
     (select id from ids where name = 'home-a'), '2026-10-15 04:00:00+00'))
  and (select quiet and ends_at = '2026-10-15 09:00:00+00' from private.notification_quiet_state(
     tests.user_id('carol'), (select id from ids where name = 'home-b'), '2026-10-15 05:30:00+00'))
  and (select not quiet from private.notification_quiet_state(tests.user_id('carol'),
     (select id from ids where name = 'home-a'), '2026-10-15 05:30:00+00')),
  'Two Homes in two zones: at 05:30 UTC Brussels is awake (07:30) while New York is still quiet (01:30)');
select tests.assert_true(
  (select not quiet from private.notification_quiet_state(tests.user_id('dave'),
     (select id from ids where name = 'home-a'), '2026-10-15 01:00:00+00')),
  'Someone who set nothing has no quiet hours');
select tests.assert_true(
  (select not quiet from private.notification_quiet_state(tests.user_id('carol'), null, '2026-10-15 19:00:00+00'))
  and (select quiet from private.notification_quiet_state(tests.user_id('carol'), null, '2026-10-15 20:30:00+00')),
  'A notice without a Home uses the account''s quiet hours');
select tests.act_as('bob');
select tests.assert_row_count($$select id from public.notification_quiet_hours$$, 0,
  'Bob reads none of Carol''s quiet hours');

-- Delivery during quiet hours: optional email waits for the window's end, essential does not, and
-- the in-app notice appears at once, marked.
select tests.act_as('carol');
select public.set_notification_preference('invitations', 'email', true, null);
select public.set_notification_quiet_hours(true, ((now() at time zone 'UTC')::time - interval '1 hour')::time, ((now() at time zone 'UTC')::time + interval '1 hour')::time, 'UTC', null);
select public.set_notification_preference('invitations', 'in_app', true, (select id from ids where name = 'home-b'));
select tests.act_as_owner();
insert into ids select 'q1', private.notify_user(tests.user_id('carol'), null, 'invitations',
  'join_request.decided', '{"decision": "approved"}', 'test:q1', true);
insert into ids select 'q2', private.notify_user(tests.user_id('carol'), null, 'security',
  'recovery.claimant_paused', '{}', 'test:q2', true);
select tests.assert_true(
  (select show_in_app and during_quiet_hours and email_status = 'queued' from public.notifications
   where id = (select id from ids where name = 'q1')),
  'During quiet hours the in-app notice appears at once, marked as arrived during quiet hours');
select tests.assert_true(
  (select o.available_at > now() + interval '59 minutes' and o.available_at <= now() + interval '61 minutes'
   from private.job_outbox o where o.idempotency_key = 'notification-email:' || (select id::text from ids where name = 'q1')),
  'Optional email is deferred to the end of the quiet window');
select tests.assert_true(
  (select o.available_at <= now() from private.job_outbox o
   where o.idempotency_key = 'notification-email:' || (select id::text from ids where name = 'q2')),
  'Essential security email is never deferred');

-- The jobs' view: re-checked at send time --------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome = 'ok' and recipient_email = 'carol@madeora.test' and locale = 'en'
     and kind = 'recovery.claimant_paused' and category = 'security' and home_id is null
   from public.get_notification_email((select id from ids where name = 'q2'))),
  'The email job gets the confirmed address, the kind and the language (English by default)');
select tests.assert_true(
  (select outcome from public.get_notification_email(gen_random_uuid())) = 'not_found', 'An unknown id is not found');
select tests.assert_true(
  (select outcome = 'ok' and home_name = 'Elders' and home_time_zone = 'America/New_York'
   from public.get_notification_email((select id from ids where name = 'n5'))),
  'A Home notice brings the Home''s name and zone');

select tests.act_as_owner();
insert into public.user_preferences (user_id, locale) values (tests.user_id('carol'), 'nl');
select tests.act_as_service_role();
select tests.assert_true(
  (select locale from public.get_notification_email((select id from ids where name = 'q2'))) = 'nl',
  'The language is the account''s saved language');

select tests.act_as('carol');
select public.set_notification_preference('invitations', 'email', false, null);
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.get_notification_email((select id from ids where name = 'q1'))) = 'disabled',
  'Turning email off after queueing stops the send (the choice is re-evaluated at delivery)');
select tests.assert_true(
  (select outcome from public.get_notification_email((select id from ids where name = 'q2'))) = 'ok',
  'but never an essential notice');
select tests.assert_true(
  public.record_notification_email((select id from ids where name = 'q1'), 'skipped'),
  'The skip is recorded');
select tests.assert_true(
  (select outcome from public.get_notification_email((select id from ids where name = 'q1'))) = 'already_done',
  'and a recorded notification is not sent');
select tests.assert_true(
  public.record_notification_email((select id from ids where name = 'q2'), 'failed', 'resend_unavailable')
  and (select outcome from public.get_notification_email((select id from ids where name = 'q2'))) = 'ok',
  'A failed send can be retried');
select tests.assert_true(
  public.record_notification_email((select id from ids where name = 'q2'), 'sent', null)
  and not public.record_notification_email((select id from ids where name = 'q2'), 'failed', 'late'),
  'A sent email is recorded once: a late duplicate cannot overwrite it');
select tests.act_as_owner();
select tests.assert_true(
  (select email_status from public.notifications where id = (select id from ids where name = 'q2')) = 'sent',
  'and it stays sent');
select tests.act_as_service_role();
select tests.assert_denied($$select public.record_notification_email(gen_random_uuid(), 'bounced')$$,
  'Only known statuses', '22023');
select tests.assert_denied($$select public.record_notification_email(gen_random_uuid(), 'failed', 'Has Spaces')$$,
  'Error codes are short sanitized codes', '22023');

-- In-app stays when email fails: the store has the notice, readable, whatever the email did.
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) from public.notifications where id = (select id from ids where name = 'q2')) = 1,
  'The in-app notice is there although its email failed and then succeeded');

-- Revoked membership -------------------------------------------------------------------------------------

select tests.act_as('carol');
select public.set_notification_preference('invitations', 'in_app', true, (select id from ids where name = 'home-a'));
select public.set_notification_preference('invitations', 'email', true, (select id from ids where name = 'home-a'));
select tests.act_as_owner();
insert into ids select 'n6', private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-a'),
  'invitations', 'join_request.received', '{}', 'test:r1', true);
select tests.assert_true((select id from ids where name = 'n6') is not null, 'Delivered while she is a member');
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
select tests.assert_true(
  not exists (select 1 from public.notification_preferences
              where user_id = tests.user_id('carol') and home_id = (select id from ids where name = 'home-a')),
  'Leaving a Home removes her overrides there');
select tests.act_as('carol');
select tests.assert_row_count(
  $$select id from public.notifications where home_id = (select id from ids where name = 'home-a')$$, 0,
  'After leaving Home A she no longer sees its notifications');
select tests.assert_true(public.mark_notifications_read(null) >= 1, 'Marking all read works');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.get_notification_email((select id from ids where name = 'n6'))) = 'not_member',
  'The email job skips a notice for a Home she has left');
select tests.act_as_owner();
select tests.assert_true(
  private.notify_user(tests.user_id('carol'), (select id from ids where name = 'home-a'),
    'invitations', 'join_request.received', '{}', 'test:r2', true) is null,
  'and nothing new is delivered for it');

-- Marking read ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) from public.notifications where read_at is null) = 0,
  'Mark all read left nothing unread (for the Homes she still belongs to)');
select tests.act_as_owner();
insert into ids select 'r1', private.notify_user(tests.user_id('gina'), (select id from ids where name = 'home-b'),
  'invitations', 'join_request.received', '{}', 'test:m1', true);
select tests.act_as('bob');
select tests.assert_true(
  public.mark_notifications_read(array[(select id from ids where name = 'r1')]) = 0,
  'Nobody marks someone else''s notification read');
select tests.act_as('gina');
select tests.assert_true(
  public.mark_notifications_read(array[(select id from ids where name = 'r1')]) = 1
  and public.mark_notifications_read(array[(select id from ids where name = 'r1')]) = 0,
  'Gina marks hers read, once');
select tests.assert_denied(
  $$select public.mark_notifications_read(array(select gen_random_uuid() from generate_series(1, 101)))$$,
  'At most 100 ids at a time', '22023');

-- Join requests ---------------------------------------------------------------------------------------------

select tests.act_as('alice');
insert into keep select 'link', token from public.create_home_invitation(
  (select id from ids where name = 'home-a'), 'link', 'member', gen_random_uuid(), null, null, '7d', 1);
select tests.act_as('hank');
insert into ids select 'req-hank', request_id from public.request_to_join_home((select value from keep where name = 'link'));
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 and bool_and(home_id = (select id from ids where name = 'home-a'))
   from public.notifications where kind = 'join_request.received'
     and (params ->> 'requestId')::uuid = (select id from ids where name = 'req-hank')),
  'A manager is told about a new join request, from its Home');
select tests.act_as('erin');
select tests.assert_row_count($$select id from public.notifications where kind = 'join_request.received'$$, 0,
  'A Member who cannot decide it is not');
select tests.act_as('alice');
select tests.assert_true(
  public.decide_join_request((select id from ids where name = 'home-a'), (select id from ids where name = 'req-hank'), 'approve') = 'approved',
  'Alice approves');
select tests.act_as('hank');
select tests.assert_true(
  (select count(*) = 1 and bool_and(home_id is null and params ->> 'decision' = 'approved')
   from public.notifications where kind = 'join_request.decided'),
  'The applicant is told, without a Home context');

-- Invitation emails (the jobs' functions) ------------------------------------------------------------------

select tests.act_as('alice');
insert into ids select 'inv', invitation_id from public.create_home_invitation(
  (select id from ids where name = 'home-a'), 'email', 'member', gen_random_uuid(), 'zed@madeora.test', 'nl', null, 1);
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome = 'ok' and recipient_email = 'zed@madeora.test' and email_locale = 'nl'
     and role = 'member' and home_name = 'Thuis' and home_time_zone = 'Europe/Brussels'
     and length(token) = 43
   from public.get_invitation_email((select id from ids where name = 'inv'), 1)),
  'The invitation job reads the recipient, language and link at send time');
select tests.assert_true(
  public.record_invitation_email((select id from ids where name = 'inv'), 1, 'sent'),
  'and records the outcome');
select tests.act_as_owner();
select tests.assert_true(
  (select delivery_status from private.home_invitations where id = (select id from ids where name = 'inv')) = 'sent',
  'which shows as the invitation''s delivery status');
select tests.act_as_owner();
update private.home_invitations set last_sent_at = now() - interval '2 minutes'
  where id = (select id from ids where name = 'inv');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.resend_home_invitation((select id from ids where name = 'home-a'), (select id from ids where name = 'inv'))) = 'ok',
  'Alice resends');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.get_invitation_email((select id from ids where name = 'inv'), 1)) = 'superseded'
  and (select outcome from public.get_invitation_email((select id from ids where name = 'inv'), 2)) = 'ok',
  'The first send is superseded by the resend');
select tests.assert_true(
  not public.record_invitation_email((select id from ids where name = 'inv'), 1, 'failed')
  and public.record_invitation_email((select id from ids where name = 'inv'), 2, 'failed'),
  'A stale send cannot overwrite the delivery status of a newer one');
select tests.act_as_owner();
select tests.assert_true(
  (select delivery_status from private.home_invitations where id = (select id from ids where name = 'inv')) = 'failed',
  'only the current send''s outcome shows');
select tests.act_as_service_role();
select tests.assert_denied($$select public.record_invitation_email(gen_random_uuid(), 1, 'bounced')$$,
  'Only known delivery statuses', '22023');
select tests.act_as('alice');
select tests.assert_true(
  public.revoke_home_invitation((select id from ids where name = 'home-a'), (select id from ids where name = 'inv')) = 'revoked',
  'Alice revokes it');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.get_invitation_email((select id from ids where name = 'inv'), 2)) = 'not_active',
  'A queued email for a revoked invitation is not sent');
select tests.assert_true(
  (select outcome from public.get_invitation_email(gen_random_uuid(), 1)) = 'not_found', 'An unknown invitation is not found');

-- Ownership recovery -----------------------------------------------------------------------------------------

select tests.act_as('dave');
insert into ids select 'case-a', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-a'),
  'Alice passed away in March; her account cannot be recovered. I am her son and can show ID.',
  gen_random_uuid());
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where kind = 'recovery.owner_requested'),
  'The Owner is told in-app that a review was requested');
select tests.act_as('erin');
select tests.assert_true(
  (select count(*) = 1 and bool_and(category = 'security' and params = jsonb_build_object('recoveryId', (select id from ids where name = 'case-a')))
   from public.notifications where kind = 'recovery.member_requested'),
  'Another member is alerted in-app, and the notice names the case but not who asked');
select tests.act_as('dave');
select tests.assert_row_count($$select id from public.notifications where kind like 'recovery.%'$$, 0,
  'The person who asked is not notified of their own request');
select tests.act_as('bob');
select tests.assert_row_count($$select id from public.notifications where kind like 'recovery.%'$$, 0,
  'Another Home hears nothing');
select tests.act_as_owner();
select tests.assert_row_count($$select 1 from private.job_outbox where job_name = 'notification-email'
  and payload ->> 'notificationId' in (select id::text from public.notifications where kind in ('recovery.owner_requested', 'recovery.member_requested'))$$, 0,
  'No email goes out at submission (the Owner is emailed when staff start checking)');

update private.home_ownership_recoveries set status = 'in_review', review_started_at = now()
  where id = (select id from ids where name = 'case-a');
select tests.assert_true(
  (select count(*) = 2 from public.notifications
   where kind in ('recovery.owner_review_started', 'recovery.claimant_review_started') and email_status = 'queued'),
  'Review started: the Owner and the person who asked are told in-app and by email');
select tests.assert_row_count($$select 1 from public.notifications where kind = 'recovery.member_review_started'$$, 0,
  'Other members are not told again');

update private.home_ownership_recoveries
  set status = 'approved', approved_at = now(), objection_ends_at = now() + interval '14 days',
      former_owner_outcome = 'removed'
  where id = (select id from ids where name = 'case-a');
select tests.assert_true(
  (select count(*) = 4 from public.notifications
   where kind in ('recovery.owner_approved', 'recovery.claimant_approved', 'recovery.member_objection_open')
     and params ->> 'recoveryId' = (select id::text from ids where name = 'case-a')),
  'Approval: the Owner, the person who asked and the two other members (Erin, Hank) are told');
select tests.assert_true(
  (select count(*) = 2 from public.notifications
   where kind in ('recovery.owner_approved', 'recovery.claimant_approved') and email_status = 'queued'
     and params ? 'objectionEndsAt' and params ->> 'recoveryId' = (select id::text from ids where name = 'case-a')),
  'The Owner and the person who asked are emailed, with the end of the objection period');
select tests.assert_row_count(
  $$select 1 from private.job_outbox where job_name = 'recovery-ready'
    and available_at = (select objection_ends_at from private.home_ownership_recoveries
                        where id = (select id from ids where name = 'case-a'))
    and payload ->> 'recoveryId' = (select id::text from ids where name = 'case-a')$$,
  1, 'A recovery-ready job waits for the end of the objection period');

select tests.act_as_owner();
insert into keep select 'ends', objection_ends_at::text from private.home_ownership_recoveries
  where id = (select id from ids where name = 'case-a');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_recovery_ready((select id from ids where name = 'case-a'),
    (select value::timestamptz from keep where name = 'ends')) = 'not_ready',
  'The ready job does nothing while the period is still running');
select tests.act_as_owner();
alter table private.home_ownership_recoveries disable trigger home_ownership_recoveries_notify;
update private.home_ownership_recoveries set objection_ends_at = now() - interval '1 minute'
  where id = (select id from ids where name = 'case-a');
alter table private.home_ownership_recoveries enable trigger home_ownership_recoveries_notify;
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_recovery_ready((select id from ids where name = 'case-a'), now() + interval '14 days') = 'not_ready',
  'A job queued for another end date (the case was resumed with a new period) does nothing');
select tests.assert_true(
  public.deliver_recovery_ready((select id from ids where name = 'case-a'), now() - interval '1 minute') = 'notified',
  'When the period has ended the person who asked is told they can accept');
select tests.assert_true(
  public.deliver_recovery_ready((select id from ids where name = 'case-a'), now() - interval '1 minute') = 'not_ready',
  'and only once, however often the job runs');
select tests.act_as('dave');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where kind = 'recovery.claimant_ready'),
  'The notice is there');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from public.notifications
   where kind = 'recovery.claimant_ready' and email_status = 'queued' and user_id = tests.user_id('dave')),
  'and its email is queued');

select tests.act_as_owner();
update private.home_ownership_recoveries set status = 'paused', paused_from = 'approved'
  where id = (select id from ids where name = 'case-a');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where kind = 'recovery.claimant_paused'
     and user_id = tests.user_id('dave')),
  'Pausing tells the person who asked (without saying why)');
update private.home_ownership_recoveries
  set status = 'approved', paused_from = null, objection_ends_at = now() + interval '15 days'
  where id = (select id from ids where name = 'case-a');
select tests.assert_true(
  (select count(*) = 2 from public.notifications where kind = 'recovery.claimant_approved'
     and user_id = tests.user_id('dave')),
  'Resuming an approved case with a new period is a new approval, with a new notice');
select tests.assert_row_count($$select 1 from private.job_outbox where job_name = 'recovery-ready'$$, 2,
  'and a new ready job; the old one no longer matches');

update private.home_ownership_recoveries set status = 'completed', decided_at = now()
  where id = (select id from ids where name = 'case-a');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where kind = 'recovery.claimant_completed' and user_id = tests.user_id('dave'))
  and (select count(*) = 1 from public.notifications
       where kind = 'recovery.former_owner_completed_removed' and user_id = tests.user_id('alice')
         and home_id is null and email_status = 'queued')
  and (select count(*) = 1 from public.notifications where kind = 'recovery.member_completed' and user_id = tests.user_id('erin')),
  'Completion: the new Owner, the former Owner (a notice without the Home, as they are removed) and members are told');

-- A second Home: rejection and the Owner returning.
select tests.act_as('carol');
insert into ids select 'case-b', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Bob has not been reachable for months and the Home needs someone to manage it, please help.',
  gen_random_uuid());
select tests.act_as_owner();
update private.home_ownership_recoveries set status = 'rejected', decided_at = now()
  where id = (select id from ids where name = 'case-b');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where kind = 'recovery.claimant_rejected'),
  'A rejection reaches the person who asked in-app');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from public.notifications
   where kind = 'recovery.claimant_rejected' and email_status = 'queued' and user_id = tests.user_id('carol')),
  'and by email');
select tests.act_as('gina');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where kind = 'recovery.member_ended'),
  'Members hear that the review ended');
select tests.act_as('carol');
insert into ids select 'case-c', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Bob still has not answered anyone and the Home has no one managing it, so I ask again.',
  gen_random_uuid());
select tests.act_as_owner();
update private.home_ownership_recoveries set status = 'owner_returned', decided_at = now()
  where id = (select id from ids where name = 'case-c');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where kind = 'recovery.claimant_ended_owner_access'),
  'When the Owner shows they have access, the person who asked is told');

-- Settings cleanup ----------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from public.notification_quiet_hours q
              where q.user_id = tests.user_id('carol') and q.home_id = (select id from ids where name = 'home-a')),
  'Leaving a Home also removed her quiet-hours override there');

-- Review follow-ups ---------------------------------------------------------------------------------

-- M2: every membership role is an adult role today (children arrive later and must be excluded from
-- the recovery alerts when they do).
select tests.assert_true(
  not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.home_memberships'::regclass and c.conname = 'home_memberships_role_check'
      and pg_get_constraintdef(c.oid) !~ $re$owner.*administrator.*member$re$
  ) and (select count(distinct role) from public.home_memberships) <= 3,
  'Home roles are owner, administrator and member: all adults'
);

-- M1: a broken outbox cannot undo the business change, and the in-app notice stays.
alter table private.job_outbox add constraint tmp_refuse_email_jobs
  check (job_name <> 'notification-email') not valid;
insert into ids select 'm1', private.notify_user(tests.user_id('dave'), (select id from ids where name = 'home-a'),
  'security', 'recovery.claimant_paused', '{}', 'test:m1', true);
select tests.assert_true(
  (select show_in_app and email_status = 'failed' and email_error_code = 'enqueue_failed'
   from public.notifications where id = (select id from ids where name = 'm1')),
  'If the outbox refuses the email job, the in-app notice is kept and the email is marked failed');
alter table private.job_outbox drop constraint tmp_refuse_email_jobs;

-- M5: after a permanent email failure the notice is still readable, counted and markable.
select tests.act_as_service_role();
select tests.assert_true(
  public.record_notification_email((select id from ids where name = 'm1'), 'failed', 'email_rejected'),
  'The email is recorded as refused');
select tests.act_as('dave');
select tests.assert_true(
  (select count(*) = 1 from public.notifications where id = (select id from ids where name = 'm1') and read_at is null),
  'The notice is readable and unread although its email was refused');
select tests.assert_true(
  public.mark_notifications_read(array[(select id from ids where name = 'm1')]) = 1,
  'and can be marked read');
select tests.act_as_owner();

-- M5: the request's correlation id is stamped on the notification and its job; anything else is not.
select set_config('request.headers', '{"x-correlation-id": "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f"}', true);
insert into ids select 'c1', private.notify_user(tests.user_id('dave'), (select id from ids where name = 'home-a'),
  'security', 'recovery.claimant_resumed', '{}', 'test:c1', true);
select tests.assert_true(
  (select n.correlation_id = '0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f'
     and o.correlation_id = '0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f'
   from public.notifications n
   join private.job_outbox o on o.idempotency_key = 'notification-email:' || n.id::text
   where n.id = (select id from ids where name = 'c1')),
  'The correlation id of the request reaches the notification and its email job');
select set_config('request.headers', '{"x-correlation-id": "not-a-uuid\nx-evil: 1"}', true);
insert into ids select 'c2', private.notify_user(tests.user_id('dave'), (select id from ids where name = 'home-a'),
  'security', 'recovery.claimant_resumed', '{}', 'test:c2', true);
select tests.assert_true(
  (select correlation_id::text ~ '^[0-9a-f-]{36}$' and correlation_id <> '0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f'
   from public.notifications where id = (select id from ids where name = 'c2')),
  'A malformed header is ignored and a fresh id is used');
select set_config('request.headers', '', true);

-- L7: the skipped branch: a confirmed account whose address is gone gets the in-app notice only.
insert into ids select 'gina-id', tests.user_id('gina');
update auth.users set email = null where id = (select id from ids where name = 'gina-id');
insert into ids select 'sk', private.notify_user((select id from ids where name = 'gina-id'), (select id from ids where name = 'home-b'),
  'security', 'recovery.claimant_paused', '{}', 'test:sk', true);
select tests.assert_true(
  (select show_in_app and email_status = 'skipped' from public.notifications where id = (select id from ids where name = 'sk')),
  'A confirmed account whose address is gone still gets the in-app notice, with the email skipped');
update auth.users set email = 'gina@madeora.test' where id = (select id from ids where name = 'gina-id');

-- L7: the other terminal and resume events.
select tests.act_as('carol');
insert into ids select 'case-d', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Bob has been silent for a very long time and nobody can reach him by any means at all.',
  gen_random_uuid());
select tests.act_as_owner();
update private.home_ownership_recoveries set status = 'in_review' where id = (select id from ids where name = 'case-d');
update private.home_ownership_recoveries set status = 'paused', paused_from = 'in_review' where id = (select id from ids where name = 'case-d');
update private.home_ownership_recoveries set status = 'in_review', paused_from = null where id = (select id from ids where name = 'case-d');
select tests.assert_true(
  exists (select 1 from public.notifications where user_id = tests.user_id('carol') and kind = 'recovery.claimant_resumed'
          and params ->> 'recoveryId' = (select id::text from ids where name = 'case-d')),
  'Resuming back to review tells the person who asked');
update private.home_ownership_recoveries set status = 'withdrawn', decided_at = now() where id = (select id from ids where name = 'case-d');
select tests.assert_true(
  exists (select 1 from public.notifications where user_id = tests.user_id('gina') and kind = 'recovery.member_ended'
          and params ->> 'recoveryId' = (select id::text from ids where name = 'case-d'))
  and not exists (select 1 from public.notifications where user_id = tests.user_id('carol') and kind like 'recovery.claimant_%'
          and params ->> 'recoveryId' = (select id::text from ids where name = 'case-d') and kind <> 'recovery.claimant_review_started'
          and kind <> 'recovery.claimant_paused' and kind <> 'recovery.claimant_resumed'),
  'A withdrawal tells the other members and sends the person who withdrew no extra notice');

-- M4: a case that ends because the person who asked left the Home still tells them, without the Home.
select tests.act_as('carol');
insert into ids select 'case-e', recovery_id from public.request_ownership_recovery(
  (select id from ids where name = 'home-b'),
  'Bob is gone and the Home needs a manager, so I would like to take over its ownership today.',
  gen_random_uuid());
select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('carol');
select tests.assert_true(
  (select count(*) = 1 and bool_and(home_id is null) and bool_and(email_status = 'queued')
   from public.notifications where user_id = tests.user_id('carol') and kind = 'recovery.claimant_invalid'
     and params ->> 'recoveryId' = (select id::text from ids where name = 'case-e')),
  'A claimant who is no longer a member is still told, in a notice without the Home');

-- L7: spring forward. Europe/Brussels skips 02:00-03:00 on 28 March 2027; a 02:30 window end falls in
-- the gap and resolves to a valid instant right after it (01:00 to 02:00 UTC).
select tests.act_as('dave');
select public.set_notification_quiet_hours(true, '23:00', '02:30', 'Europe/Brussels', null);
select tests.act_as_owner();
select tests.assert_true(
  (select quiet and ends_at >= '2027-03-28 01:00:00+00' and ends_at <= '2027-03-28 02:00:00+00'
   from private.notification_quiet_state(tests.user_id('dave'), null, '2027-03-27 23:30:00+00')),
  'Across the spring-forward gap the window ends at a valid instant right after it');

-- L2: an override cannot be written for a membership that is being removed (the row is locked
-- first; the concurrency itself is covered by the membership delete cleanup test above).
select tests.assert_true(private.lock_membership((select id from ids where name = 'home-a'), tests.user_id('dave')),
  'The membership lock reports a current member');
select tests.assert_true(not private.lock_membership((select id from ids where name = 'home-b'), tests.user_id('carol')),
  'and a person who left');
