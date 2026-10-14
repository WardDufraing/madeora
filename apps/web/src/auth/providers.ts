import "server-only";

import { getPublicEnv } from "@madeora/config/env/public";
import { cache } from "react";
import { z } from "zod";

const authSettingsSchema = z.object({
  external: z.object({ google: z.boolean().optional() }).partial().optional(),
});

/**
 * Whether Supabase Auth has Google sign-in switched on (S08). Without it, Supabase answers the
 * Google button with a bare error page, so the pages only offer Google when this is true.
 *
 * Reads Supabase Auth's public settings endpoint (no account data; supabase-js has no method for
 * it). The answer is the same for everyone, so Next.js may reuse it for a minute. Any failure
 * counts as "off": the email and password form always works.
 */
export const isGoogleSignInEnabled = cache(async (): Promise<boolean> => {
  const env = getPublicEnv();
  try {
    const response = await fetch(new URL("/auth/v1/settings", env.NEXT_PUBLIC_SUPABASE_URL), {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const settings = authSettingsSchema.safeParse(await response.json());
    return settings.success && settings.data.external?.google === true;
  } catch {
    return false;
  }
});
