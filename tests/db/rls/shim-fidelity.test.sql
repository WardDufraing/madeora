-- Role attributes the RLS tests depend on. These are true on Supabase, and the fallback shim
-- (tests/db/shim/supabase-shim.sql) must match, so a test means the same thing on both.
select tests.assert_true(
  (select not rolsuper and rolbypassrls from pg_roles where rolname = 'postgres'),
  'The owner role postgres is not a superuser and bypasses RLS, as on Supabase'
);
select tests.assert_true(
  (select rolbypassrls from pg_roles where rolname = 'service_role'),
  'service_role bypasses RLS'
);
select tests.assert_true(
  (select bool_and(not rolbypassrls and not rolsuper) from pg_roles where rolname in ('anon', 'authenticated')),
  'anon and authenticated never bypass RLS'
);
