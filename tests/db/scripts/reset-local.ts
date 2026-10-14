// Usage: pnpm db:reset [--yes]   (from the repository root)
//
// Rebuilds the LOCAL Supabase database from scratch: drops it, applies every migration in
// supabase/migrations in order, then loads supabase/seed.sql (architecture.md §25). Always passes
// --local, so it can never reset a hosted project. Asks for confirmation unless --yes is given.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const warning = `
WARNING: this permanently deletes ALL data in your local Supabase database.
Only what is in supabase/migrations and supabase/seed.sql comes back.
It never touches a hosted Supabase project.
`;

console.warn(warning);

let confirmed = process.argv.includes("--yes");
if (!confirmed) {
  if (!process.stdin.isTTY) {
    console.error("DB reset: not confirmed. Run `pnpm db:reset --yes` to reset without a prompt.");
    process.exit(1);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Type "reset" to continue: ');
  prompt.close();
  confirmed = answer.trim() === "reset";
}
if (!confirmed) {
  console.error("DB reset: cancelled, nothing was changed.");
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "supabase", "db", "reset", "--local"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
