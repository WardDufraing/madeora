import { spawnSync } from "node:child_process";

/**
 * Direct access to the throwaway test database, for what the app cannot do yet: Home membership
 * is only created by the Home's own creation until invitations arrive (S10), so tests that need
 * a person to belong to somebody else's Home, or to lose that membership, set it up here. CI and
 * `pnpm test:e2e:fallback` pass E2E_DATABASE_URL; it must be this machine (architecture.md §24).
 */
function databaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "E2E_DATABASE_URL is not set. Run the browser tests through CI's steps or pnpm test:e2e:fallback (docs/development.md).",
    );
  }
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error(
      "E2E_DATABASE_URL must be a database on this machine; tests never use a hosted one.",
    );
  }
  return url;
}

/** Runs SQL as the database owner, with `:'name'` variables, in one transaction. */
export function sql(statements: string, variables: Record<string, string> = {}): string {
  const args = Object.entries(variables).flatMap(([name, value]) => ["-v", `${name}=${value}`]);
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "-X", "-q", "-t", "-A", "-1", "-v", "ON_ERROR_STOP=1", ...args, databaseUrl()],
    { input: statements, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr || String(result.error)}`);
  return result.stdout.trim();
}

/** A Home owned by `ownerEmail`, created directly; returns its id. */
export function createHomeFor(ownerEmail: string, name: string): string {
  return sql(
    `
    with owner as (select id from auth.users where email = :'email'),
    home as (
      insert into public.homes (name, timezone, created_by, creation_request_id)
      select :'name', 'Europe/Brussels', id, gen_random_uuid() from owner
      returning id
    ),
    membership as (
      insert into public.home_memberships (home_id, user_id, role)
      select home.id, owner.id, 'owner' from home, owner
    )
    select id from home;
    `,
    { email: ownerEmail, name },
  );
}

/** Gives `email` a membership in the Home (its Owner is unchanged). */
export function addMember(homeId: string, email: string, role: "administrator" | "member"): void {
  sql(
    `insert into public.home_memberships (home_id, user_id, role)
     select :'home'::uuid, id, :'role' from auth.users where email = :'email';`,
    { home: homeId, email, role },
  );
}

/** Ends `email`'s membership in the Home. */
export function removeMember(homeId: string, email: string): void {
  sql(
    `delete from public.home_memberships
     where home_id = :'home'::uuid and user_id = (select id from auth.users where email = :'email');`,
    { home: homeId, email },
  );
}
