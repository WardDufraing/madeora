-- S47: the daily Ora teaser, the teaser mute and dismissed suggestions
-- (supabase/migrations/20261207090000_ora_suggestions.sql). Alice, Bob and Carol are seeded
-- synthetic accounts. A person gets one teaser per local date however many Homes or devices ask,
-- none while muted, and only they can read or write their own dismissals.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());

-- Signed-out visitors ------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select public.claim_ora_teaser((now() at time zone 'utc')::date)$$,
  'A signed-out visitor cannot claim a teaser'
);
select tests.assert_denied('select scope from public.ora_dismissed_suggestions',
  'A signed-out visitor cannot read dismissals');

-- One teaser per person per day ----------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  public.claim_ora_teaser((now() at time zone 'utc')::date),
  'Alice gets today''s teaser the first time she asks (no settings row yet)'
);
select tests.assert_true(
  not public.claim_ora_teaser((now() at time zone 'utc')::date),
  'Asking again, from another Home or device, gives no second teaser'
);
select tests.assert_true(
  public.claim_ora_teaser((now() at time zone 'utc')::date + 1),
  'The next local date gets its own teaser'
);
select tests.assert_true(
  not public.claim_ora_teaser((now() at time zone 'utc')::date),
  'An earlier date than the last teaser cannot claim again'
);
select tests.assert_true(
  not public.claim_ora_teaser((now() at time zone 'utc')::date + 30),
  'A date far from the real one is refused, so a forged date buys no extra teaser'
);
select tests.assert_true(
  not public.claim_ora_teaser(null),
  'No date, no teaser'
);
select tests.assert_denied(
  $$update public.ora_preferences set last_teaser_on = null where user_id = tests.user_id('alice')$$,
  'Alice cannot rewrite the teaser day herself'
);

-- Muting ---------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_allowed(
  $$insert into public.ora_preferences (user_id, teasers_muted)
    values (tests.user_id('bob'), true)
    on conflict (user_id) do update
      set user_id = excluded.user_id, teasers_muted = excluded.teasers_muted$$,
  'Bob can mute teasers'
);
select tests.assert_true(
  not public.claim_ora_teaser((now() at time zone 'utc')::date),
  'A muted person is never given a teaser'
);
select tests.assert_allowed(
  $$update public.ora_preferences set teasers_muted = false where user_id = tests.user_id('bob')$$,
  'Bob can turn teasers back on'
);
select tests.assert_true(
  public.claim_ora_teaser((now() at time zone 'utc')::date),
  'After un-muting he gets today''s teaser, which the mute had not used up'
);

select tests.act_as('carol');
select tests.assert_true(
  public.claim_ora_teaser((now() at time zone 'utc')::date),
  'One person''s teaser or mute never changes another''s'
);

-- Dismissed suggestions --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_allowed(
  $$insert into public.ora_dismissed_suggestions (scope, kind, situation)
    values ('personal', 'today-overview', '2026-11-16')
    on conflict (user_id, scope, kind) do update set situation = excluded.situation$$,
  'Alice can dismiss a suggestion in Personal space'
);
select tests.assert_allowed(
  $$insert into public.ora_dismissed_suggestions (scope, home_id, kind, situation)
    values ((select id::text from ids where name = 'home-a'),
            (select id from ids where name = 'home-a'), 'today-overview', '2026-11-16')$$,
  'Alice can dismiss one in her own Home'
);
select tests.assert_row_count('select * from public.ora_dismissed_suggestions', 2,
  'Alice reads her own two dismissals');
select tests.assert_denied(
  $$insert into public.ora_dismissed_suggestions (scope, home_id, kind, situation)
    values ((select id::text from ids where name = 'home-b'),
            (select id from ids where name = 'home-b'), 'today-overview', '2026-11-16')$$,
  'Alice cannot dismiss in a Home she does not belong to'
);
select tests.assert_denied(
  $$insert into public.ora_dismissed_suggestions (scope, kind, situation)
    values ('personal', 'something-else', 'x')$$,
  'An unknown suggestion kind is refused', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_dismissed_suggestions (scope, home_id, kind, situation)
    values ('personal', (select id from ids where name = 'home-a'), 'today-overview', 'x')$$,
  'A place and its Home must agree', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_dismissed_suggestions (user_id, scope, kind, situation)
    values (tests.user_id('bob'), 'personal', 'today-overview', 'x')$$,
  'Alice cannot dismiss for Bob'
);
select tests.assert_denied(
  $$delete from public.ora_dismissed_suggestions where user_id = tests.user_id('alice')$$,
  'Nobody deletes a dismissal through the API'
);

select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_dismissed_suggestions', 0,
  'Bob cannot read Alice''s dismissals, an Owner of another Home included');
select tests.assert_row_count(
  $$update public.ora_dismissed_suggestions set situation = 'x' returning user_id$$, 0,
  'Bob cannot change Alice''s dismissals'
);

-- Leaving a Home deletes the dismissals there -------------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');
select tests.assert_row_count(
  $$select * from public.ora_dismissed_suggestions
    where home_id = (select id from ids where name = 'home-a')$$,
  0,
  'Leaving a Home deletes the dismissals there'
);
select tests.assert_row_count(
  $$select * from public.ora_dismissed_suggestions where scope = 'personal'$$,
  1,
  'Her Personal dismissal is untouched by leaving a Home'
);
