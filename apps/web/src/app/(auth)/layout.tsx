import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getAuthState } from "@/auth/identity";
import { DISPLAY_PATH } from "@/auth/redirects";

/**
 * Pages for people who are not signed in yet (and the reset-password page). No app shell: the
 * navigation would lead nowhere without an account.
 *
 * S43: a Household Display never reaches these pages (sign-up, sign-in with Google, remembered
 * accounts, recovery): leaving display mode is a Home manager's decision, so a passer-by cannot
 * sign in over it or see remembered account names here.
 */
export default async function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  if ((await getAuthState()).kind === "display") redirect(DISPLAY_PATH);
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center">
      <main id="main" className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center justify-center gap-3" aria-hidden="true">
          <span className="flex size-9 items-center justify-center rounded-control bg-fg text-body font-bold text-page">
            M
          </span>
          <span className="text-section-title font-semibold text-fg">Madeora</span>
        </div>
        <div className="rounded-card border border-line bg-surface p-5 text-fg shadow-card sm:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
