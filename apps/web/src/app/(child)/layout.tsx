import type { ReactNode } from "react";

/**
 * The pages of a signed-in child (S42). No app shell: a child's session reaches only these pages
 * and the `child_*` database functions, never the adult navigation.
 */
export default function ChildLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <main id="main" className="flex w-full max-w-2xl flex-col gap-6">
        {children}
      </main>
    </div>
  );
}
