import type { ReactNode } from "react";

/**
 * The Household Display pages (S43). No app shell: an unregistered tablet sees only its pairing
 * screen, and a paired display's session reaches only this page and the `display_*` database
 * functions, never member navigation, settings or administration. The paired board (S44) uses the
 * full screen; every other state is centred.
 */
export default function DisplayLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main id="main" className="flex min-h-dvh w-full flex-col">
      {children}
    </main>
  );
}
