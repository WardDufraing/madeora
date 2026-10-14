-- S07: public.user_preferences. Each account reads, creates and changes only its own row; nobody
-- deletes one through the API; created_at and updated_at are the database's; invalid values are
-- refused even when someone writes to the Data API directly.

-- Alice saves her preferences the way the app does (an upsert of her own row).
select tests.act_as('alice');
select tests.assert_row_count(
  'select * from public.user_preferences', 0, 'A new account has no preferences row yet'
);
select tests.assert_allowed(
  $$insert into public.user_preferences (user_id, display_name, locale, timezone)
    values (tests.user_id('alice'), 'Alice', 'nl', 'Europe/Brussels')
    on conflict (user_id) do update
      set display_name = excluded.display_name, locale = excluded.locale$$,
  'Alice can create her own preferences row'
);
select tests.assert_allowed(
  $$insert into public.user_preferences (user_id, week_start)
    values (tests.user_id('alice'), 'sunday')
    on conflict (user_id) do update set user_id = excluded.user_id, week_start = excluded.week_start$$,
  'Alice can upsert her existing row, naming every saved column as the Data API does'
);
select tests.assert_row_count(
  $$select * from public.user_preferences
    where display_name = 'Alice' and locale = 'nl' and week_start = 'sunday'
      and timezone = 'Europe/Brussels'$$,
  1,
  'The upsert changed only the columns it named'
);

-- Bob has a row too, written while acting as Bob.
select tests.act_as('bob');
select tests.assert_denied(
  $$insert into public.user_preferences (display_name, created_at) values ('Bob', '2000-01-01')$$,
  'created_at cannot be set on insert through the API'
);
select tests.assert_denied(
  $$insert into public.user_preferences (display_name, updated_at) values ('Bob', '2000-01-01')$$,
  'updated_at cannot be set on insert through the API'
);
-- Without user_id the row belongs to the signed-in account (default auth.uid()).
select tests.assert_allowed(
  $$insert into public.user_preferences (display_name, locale) values ('Bob', 'en')$$,
  'Bob can create his own preferences row'
);
select tests.assert_row_count(
  $$select * from public.user_preferences where user_id = tests.user_id('bob')$$,
  1,
  'A row created without user_id belongs to Bob'
);
select tests.assert_row_count(
  'select * from public.user_preferences', 1, 'Bob sees exactly one row: his own'
);
select tests.assert_row_count(
  $$select * from public.user_preferences where user_id = tests.user_id('alice')$$,
  0,
  'Bob cannot read Alice''s preferences'
);
select tests.assert_row_count(
  $$update public.user_preferences set locale = 'en'
    where user_id = tests.user_id('alice') returning user_id$$,
  0,
  'Bob cannot change Alice''s preferences'
);
-- An UPDATE that reads no column skips the SELECT policy, so only the UPDATE policy limits it.
select tests.assert_row_count(
  $$update public.user_preferences set week_start = 'monday' returning 1$$,
  1,
  'An unfiltered update by Bob reaches only his own row'
);
select tests.assert_denied(
  $$insert into public.user_preferences (user_id, display_name)
    values (tests.user_id('alice'), 'forged')$$,
  'Bob cannot create a row in Alice''s name (forged user_id)'
);
select tests.assert_denied(
  $$insert into public.user_preferences (user_id, display_name)
    values (tests.user_id('alice'), 'forged')
    on conflict (user_id) do update set display_name = excluded.display_name$$,
  'Bob cannot overwrite Alice''s row through an upsert'
);
select tests.assert_denied(
  $$update public.user_preferences set user_id = tests.user_id('alice')
    where user_id = tests.user_id('bob')$$,
  'Bob cannot hand his row to Alice (user_id change)'
);
select tests.assert_denied(
  $$delete from public.user_preferences where user_id = tests.user_id('bob')$$,
  'Nobody deletes a preferences row through the API, not even their own'
);
select tests.assert_denied(
  'truncate public.user_preferences',
  'Nobody empties the table through the API'
);
select tests.assert_denied(
  $$update public.user_preferences set updated_at = '2000-01-01' where user_id = tests.user_id('bob')$$,
  'updated_at is not writable through the API'
);
select tests.assert_denied(
  $$update public.user_preferences set created_at = '2000-01-01' where user_id = tests.user_id('bob')$$,
  'created_at is not writable through the API'
);

-- Alice still has her own values: nothing Bob tried reached them.
select tests.act_as_owner();
select tests.assert_row_count(
  $$select * from public.user_preferences
    where user_id = tests.user_id('alice') and display_name = 'Alice' and locale = 'nl'
      and week_start = 'sunday'$$,
  1,
  'Alice''s row is unchanged after Bob''s attempts'
);

-- A signed-out visitor sees and writes nothing.
select tests.act_as_anon();
select tests.assert_denied(
  'select * from public.user_preferences', 'A signed-out visitor cannot read preferences'
);
select tests.assert_denied(
  $$insert into public.user_preferences (user_id, locale) values (tests.user_id('alice'), 'en')$$,
  'A signed-out visitor cannot write preferences'
);

-- The server role bypasses RLS and sees both rows: RLS, not a missing row, hid them above.
select tests.act_as_service_role();
select tests.assert_row_count(
  $$select * from public.user_preferences
    where user_id in (tests.user_id('alice'), tests.user_id('bob'))$$,
  2,
  'The service role sees both rows'
);

-- updated_at follows every change; the client cannot set it.
select tests.act_as_owner();
update public.user_preferences set updated_at = '2000-01-01', created_at = '2000-01-01'
  where user_id = tests.user_id('alice');
select tests.act_as('alice');
select tests.assert_allowed(
  $$update public.user_preferences set time_format = '12h' where user_id = tests.user_id('alice')$$,
  'Alice can change her time format'
);
select tests.assert_row_count(
  $$select * from public.user_preferences
    where user_id = tests.user_id('alice') and updated_at > created_at$$,
  1,
  'Changing a preference moves updated_at'
);

-- Invalid values are refused by the database (23514: check_violation).
select tests.assert_denied(
  $$update public.user_preferences set locale = 'fr' where user_id = tests.user_id('alice')$$,
  'An unsupported language is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = '' where user_id = tests.user_id('alice')$$,
  'An empty display name is refused (use NULL to clear it)', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = ' Alice' where user_id = tests.user_id('alice')$$,
  'A display name with surrounding spaces is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = repeat('a', 51) where user_id = tests.user_id('alice')$$,
  'A display name longer than 50 characters is refused', '23514'
);
select tests.assert_allowed(
  $$update public.user_preferences set display_name = repeat('é', 50) where user_id = tests.user_id('alice')$$,
  'A 50-character display name with accents is accepted (characters, not bytes)'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'Ali\nce' where user_id = tests.user_id('alice')$$,
  'A display name with a control character is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'Ali\u202Ece' where user_id = tests.user_id('alice')$$,
  'A display name with a bidirectional override is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'Ali\u2028ce' where user_id = tests.user_id('alice')$$,
  'A display name with a line separator is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'Ali\u200Fce' where user_id = tests.user_id('alice')$$,
  'A display name with a direction mark is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'Ali\u0085ce' where user_id = tests.user_id('alice')$$,
  'A display name with a C1 control character is refused', '23514'
);
select tests.assert_allowed(
  $$update public.user_preferences set display_name = E'Ali\u00A0ce \U0001F469\u200D\U0001F467' where user_id = tests.user_id('alice')$$,
  'A no-break space inside and an emoji sequence with a zero-width joiner are accepted, as in the app'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'Ame\u0301lie' where user_id = tests.user_id('alice')$$,
  'A display name that is not NFC-normalized is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set date_format = 'dd/mm/yyyy' where user_id = tests.user_id('alice')$$,
  'An unknown date format is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set week_start = 'friday' where user_id = tests.user_id('alice')$$,
  'An unknown first day of the week is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set number_format = 'dot-dot' where user_id = tests.user_id('alice')$$,
  'An unknown number format is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set measurement_system = 'imperial' where user_id = tests.user_id('alice')$$,
  'An unknown measurement system is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set time_format = '13h' where user_id = tests.user_id('alice')$$,
  'An unknown time format is refused', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set timezone = '+05:00' where user_id = tests.user_id('alice')$$,
  'A UTC offset is not a timezone name', '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set timezone = 'Europe/Brussels; drop table x' where user_id = tests.user_id('alice')$$,
  'A malformed timezone is refused', '23514'
);
select tests.assert_allowed(
  $$update public.user_preferences
    set timezone = 'America/Argentina/Buenos_Aires', date_format = null, time_format = null
    where user_id = tests.user_id('alice')$$,
  'A three-part zone name is accepted, and settings return to Automatic with NULL'
);
select tests.assert_allowed(
  $$update public.user_preferences set timezone = 'UTC' where user_id = tests.user_id('alice')$$,
  'UTC is accepted'
);

-- Deleting the account deletes its preferences.
select tests.act_as_owner();
delete from auth.users where id = tests.user_id('bob');
select tests.assert_true(
  not exists (
    select 1 from public.user_preferences
    where user_id = '10000000-0000-4000-8000-000000000002'
  ),
  'Deleting an account deletes its preferences row'
);
