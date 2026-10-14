import type { ReactNode } from "react";

/**
 * Pages for people who are not signed in yet (and the reset-password page). No app shell: the
 * navigation would lead nowhere without an account.
 */
export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
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
