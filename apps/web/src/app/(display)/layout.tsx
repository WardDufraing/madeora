import type { ReactNode } from "react";

/**
 * The Household Display pages (S43). No app shell: an unregistered tablet sees only its pairing
 * screen, and a paired display's session reaches only this page and the `display_*` database
 * functions, never member navigation, settings or administration.
 */
export default function DisplayLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <main id="main" className="flex w-full max-w-3xl flex-col items-center gap-6 text-center">
        {children}
      </main>
    </div>
  );
}
