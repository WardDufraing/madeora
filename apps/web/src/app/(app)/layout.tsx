import type { ReactNode } from "react";

import { requireIdentity } from "@/auth/identity";
import { AccentStyle } from "@/components/accent/accent-style";
import { AppProviders } from "@/components/auth/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { listMyHomes } from "@/homes/server";
import { getStoredPreferences } from "@/preferences/account";
import { getDevicePreferences } from "@/preferences/server";

/** Every page in this group needs a confirmed account (each page checks again, see requireIdentity). */
export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [identity, { sidebar }, myHomes, stored] = await Promise.all([
    requireIdentity(),
    getDevicePreferences(),
    listMyHomes(),
    getStoredPreferences(),
  ]);
  // The person's global accent (S11) colours the app; a Home's layout may override it inside that
  // Home. Account state, so it is read per request and never cached across people.
  return (
    <AppProviders userId={identity.userId}>
      <AccentStyle color={stored.accentColor} />
      <AppShell sidebar={sidebar} homes={myHomes.status === "ok" ? myHomes.homes : null}>
        {children}
      </AppShell>
    </AppProviders>
  );
}
