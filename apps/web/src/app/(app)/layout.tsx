import type { ReactNode } from "react";

import { requireIdentity } from "@/auth/identity";
import { AppProviders } from "@/components/auth/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { listMyHomes } from "@/homes/server";
import { getDevicePreferences } from "@/preferences/server";

/** Every page in this group needs a confirmed account (each page checks again, see requireIdentity). */
export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [identity, { sidebar }, myHomes] = await Promise.all([
    requireIdentity(),
    getDevicePreferences(),
    listMyHomes(),
  ]);
  return (
    <AppProviders userId={identity.userId}>
      <AppShell sidebar={sidebar} homes={myHomes.status === "ok" ? myHomes.homes : null}>
        {children}
      </AppShell>
    </AppProviders>
  );
}
