-- Database-wide guards that every migration must keep true. They run against the fully migrated
-- and seeded database, so a later step that forgets RLS on a new table fails here.

-- Supabase grants every API role access to new tables in schema public by default, so a table
-- without row level security would be readable and writable by anyone with the public API key.
select tests.assert_true(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ),
  'Every table in schema public has row level security enabled'
);

-- A view runs with its owner's rights unless it is security_invoker, which would bypass RLS.
select tests.assert_true(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and not coalesce(c.reloptions @> array['security_invoker=true'], false)
  ),
  'Every view in schema public is security_invoker (materialized views are not allowed there)'
);

-- Internal helpers live in schema private, which the API roles cannot use.
select tests.assert_true(
  not has_schema_privilege('anon', 'private', 'usage')
    and not has_schema_privilege('authenticated', 'private', 'usage'),
  'The API roles anon and authenticated cannot use schema private'
);

-- The synthetic seed is loaded, with its fixed IDs.
select tests.assert_true(
  tests.user_id('alice') = '10000000-0000-4000-8000-000000000001'
    and tests.user_id('bob') = '10000000-0000-4000-8000-000000000002',
  'The seeded synthetic users alice and bob exist with their fixed IDs'
);
