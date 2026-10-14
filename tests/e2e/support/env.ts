// Where the tests reach the app's Supabase and its mail catcher. CI passes the local Supabase
// stack's values; `pnpm test:e2e:fallback` passes its own (tests/e2e/scripts/auth-fallback.ts).

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is not set. Run the browser tests through CI's steps or pnpm test:e2e:fallback (docs/development.md).`,
    );
  return value;
}

export const e2eEnv = {
  /** Refuses anything but this machine: tests create and delete accounts (architecture.md §24). */
  get supabaseUrl(): string {
    const url = required("NEXT_PUBLIC_SUPABASE_URL");
    if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL must be a Supabase on this machine; tests never use a hosted project.",
      );
    }
    return url;
  },
  get publishableKey(): string {
    return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  /** Mailpit's HTTP address: the Supabase CLI's default port unless the fallback says otherwise. */
  get mailpitUrl(): string {
    return process.env.PLAYWRIGHT_MAILPIT_URL ?? "http://127.0.0.1:54324";
  },
};
