"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { AuthSync } from "./auth-sync";

export interface AppProvidersProps {
  readonly userId: string;
  readonly children: ReactNode;
}

/**
 * Client-side providers for signed-in pages. One QueryClient per browser tab, created here and
 * never on the server, so no cached data is shared between requests or people.
 */
export function AppProviders({ userId, children }: AppProvidersProps) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthSync userId={userId} />
      {children}
    </QueryClientProvider>
  );
}
