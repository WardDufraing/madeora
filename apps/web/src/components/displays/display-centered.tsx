import type { ReactNode } from "react";

/** The centred column of the display's pairing, retry and sign-out screens (S43, S44). */
export function DisplayCentered({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-3xl flex-col items-center gap-6 text-center">
        {children}
      </div>
    </div>
  );
}
