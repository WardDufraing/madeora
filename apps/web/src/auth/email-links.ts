import { getPublicEnv } from "@madeora/config/env/public";

/**
 * Where an email link sends people back to: always the configured app address
 * (`NEXT_PUBLIC_APP_URL`; on a preview, its branch address), never the address the browser happens
 * to be on. Supabase Auth only accepts addresses on its allow-list, which can then list exact
 * addresses instead of a wildcard that other Vercel projects could match (ADR 0007).
 */
export function emailLinkTarget(path: "/auth/confirm" | "/reset-password"): string {
  return new URL(path, getPublicEnv().NEXT_PUBLIC_APP_URL).toString();
}
