import type { ReactNode } from "react";

import { requireIdentity } from "@/auth/identity";
import { AppProviders } from "@/components/auth/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { getDevicePreferences } from "@/preferences/server";

/** Every page in this group needs a confirmed account (each page checks again, see requireIdentity). */
export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [identity, { sidebar }] = await Promise.all([requireIdentity(), getDevicePreferences()]);
  return (
    <AppProviders userId={identity.userId}>
      <AppShell sidebar={sidebar}>{children}</AppShell>
    </AppProviders>
  );
}
