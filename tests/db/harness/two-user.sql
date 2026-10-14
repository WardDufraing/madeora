-- Two-user RLS check for the harness self-test. It runs after harness/notes-fixture.sql.
-- The table is granted to every API role, so only the policy keeps one user's notes from the other.

-- Alice sees and changes only her own note.
select tests.act_as('alice');
select tests.assert_row_count('select * from harness.notes', 1, 'Alice sees exactly one note');
select tests.assert_row_count(
  $$select * from harness.notes where id = '20000000-0000-4000-8000-000000000002'$$,
  0,
  'Alice cannot read Bob''s note'
);
select tests.assert_row_count(
  $$update harness.notes set body = 'changed' where id = '20000000-0000-4000-8000-000000000002' returning id$$,
  0,
  'Alice cannot change Bob''s note'
);
select tests.assert_row_count(
  $$delete from harness.notes where id = '20000000-0000-4000-8000-000000000002' returning id$$,
  0,
  'Alice cannot delete Bob''s note'
);
select tests.assert_denied(
  $$insert into harness.notes (owner_id, body) values (tests.user_id('bob'), 'forged')$$,
  'Alice cannot add a note in Bob''s name (forged owner_id)'
);
select tests.assert_allowed(
  $$insert into harness.notes (body) values ('Alice''s second note')$$,
  'Alice can add her own note'
);

-- Bob still sees only his own note: Alice's new note is invisible to him.
select tests.act_as('bob');
select tests.assert_row_count('select * from harness.notes', 1, 'Bob sees exactly one note');
select tests.assert_row_count(
  $$select * from harness.notes where owner_id = tests.user_id('alice')$$,
  0,
  'Bob cannot read any of Alice''s notes'
);

-- A visitor who is not signed in sees nothing and cannot write.
select tests.act_as_anon();
select tests.assert_row_count('select * from harness.notes', 0, 'A signed-out visitor sees no notes');
select tests.assert_denied(
  $$insert into harness.notes (owner_id, body) values (tests.user_id('alice'), 'anonymous')$$,
  'A signed-out visitor cannot add a note'
);

-- The privileged server role bypasses RLS and sees every row, so the rows above were hidden by
-- the policy and not missing.
select tests.act_as_service_role();
select tests.assert_row_count('select * from harness.notes', 3, 'The service role sees all three notes');
