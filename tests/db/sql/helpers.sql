-- Multi-actor RLS test helpers.
--
-- The test runner (tests/db/src/run-sql.ts) prepends this file to every SQL test and runs the
-- whole script inside one transaction that is always rolled back, so neither these helpers nor
-- anything a test creates is ever left in the database.
--
-- Acting as someone works like a real Supabase API request: the session switches to the API
-- role (anon, authenticated or service_role) and sets the request.jwt.claims that auth.uid(),
-- auth.role() and auth.jwt() read. Policies therefore see exactly what they would see for a
-- signed-in user, and only RLS stands between that user and the rows.
--
-- Assertions raise an exception on failure. The runner stops at the first failure and reports
-- its message, so every assertion needs a description that says what was expected.

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Actors ---------------------------------------------------------------------------------------

-- The ID of a seeded synthetic user, by the part of their email before "@madeora.test".
create function tests.user_id(name text) returns uuid
  language plpgsql stable security definer
  set search_path = ''
  as $$
  declare
    found uuid;
  begin
    select u.id into found from auth.users u where u.email = name || '@madeora.test';
    if found is null then
      raise exception 'tests.user_id: no seeded user %@madeora.test (see supabase/seed.sql)', name;
    end if;
    return found;
  end
  $$;

-- Act as a signed-in user, as the Data API does for a request carrying that user's JWT.
create function tests.act_as_user(user_id uuid) returns void
  language plpgsql
  as $$
  begin
    if user_id is null then
      raise exception 'tests.act_as_user: user_id must not be null';
    end if;
    perform set_config('role', 'authenticated', true);
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', user_id, 'role', 'authenticated', 'aud', 'authenticated')::text,
      true
    );
  end
  $$;

-- Act as a seeded user by name, for example tests.act_as('alice').
create function tests.act_as(name text) returns void
  language plpgsql
  as $$
  begin
    perform tests.act_as_user(tests.user_id(name));
  end
  $$;

-- Act as a visitor who is not signed in.
create function tests.act_as_anon() returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  end
  $$;

-- Act as the privileged server role, which bypasses RLS. Tests use it to prove that RLS, and
-- not a missing grant, is what hides rows from other actors.
create function tests.act_as_service_role() returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  end
  $$;

-- Back to the database owner (postgres) that runs migrations, for fixtures and checks.
create function tests.act_as_owner() returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  end
  $$;

-- Assertions -----------------------------------------------------------------------------------
-- Each one runs `query` as the current actor, so RLS applies exactly as for that actor.

-- `query` (a SELECT, or a data-changing statement with RETURNING) returns `expected` rows.
create function tests.assert_row_count(query text, expected bigint, description text)
  returns void
  language plpgsql
  as $$
  declare
    actual bigint;
  begin
    execute format('with q as (%s) select count(*) from q', query) into actual;
    if actual is distinct from expected then
      raise exception 'RLS assertion failed: % (expected % rows, got %)', description, expected, actual
        using errcode = 'MT001';
    end if;
  end
  $$;

-- `query` succeeds.
create function tests.assert_allowed(query text, description text)
  returns void
  language plpgsql
  as $$
  begin
    execute query;
  exception
    when sqlstate 'MT001' then raise;
    when others then
      raise exception 'RLS assertion failed: % (expected success, got % %)', description, sqlstate, sqlerrm
        using errcode = 'MT001';
  end
  $$;

-- `query` is refused with `expected_sqlstate` (default 42501, insufficient_privilege: what Postgres
-- raises for a missing grant and for a row that violates a policy's WITH CHECK).
create function tests.assert_denied(
  query text,
  description text,
  expected_sqlstate text default '42501'
)
  returns void
  language plpgsql
  as $$
  begin
    execute query;
    raise exception 'RLS assertion failed: % (expected error %, but the statement succeeded)',
      description, expected_sqlstate
      using errcode = 'MT001';
  exception
    when sqlstate 'MT001' then raise;
    when others then
      if sqlstate <> expected_sqlstate then
        raise exception 'RLS assertion failed: % (expected error %, got % %)',
          description, expected_sqlstate, sqlstate, sqlerrm
          using errcode = 'MT001';
      end if;
  end
  $$;

-- A plain condition, for checks that are not about one query.
create function tests.assert_true(condition boolean, description text)
  returns void
  language plpgsql
  as $$
  begin
    if condition is not true then
      raise exception 'RLS assertion failed: %', description using errcode = 'MT001';
    end if;
  end
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
