-- Fixture for the harness self-test only (harness/two-user.test.ts). It is created inside the
-- test's rolled-back transaction and never exists in a migration or a real database.
--
-- A private notes table: each note belongs to one user, and only that user may read, add,
-- change or delete it. The same shape as every owner-scoped table later steps will add.

create schema harness;
grant usage on schema harness to anon, authenticated, service_role;

create table harness.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id),
  body text not null
);
grant select, insert, update, delete on harness.notes to anon, authenticated, service_role;

alter table harness.notes enable row level security;

create policy notes_owner_only on harness.notes
  for all
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

insert into harness.notes (id, owner_id, body) values
  ('20000000-0000-4000-8000-000000000001', tests.user_id('alice'), 'Alice''s note'),
  ('20000000-0000-4000-8000-000000000002', tests.user_id('bob'), 'Bob''s note');
