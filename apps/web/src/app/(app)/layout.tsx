import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { getDevicePreferences } from "@/preferences/server";

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { sidebar } = await getDevicePreferences();
  return <AppShell sidebar={sidebar}>{children}</AppShell>;
}
