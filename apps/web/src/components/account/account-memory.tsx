"use client";

import { useEffect } from "react";

import { forgetAccount, rememberAccount, rememberChoice } from "@/auth/remembered-accounts";

export interface AccountMemoryProps {
  readonly userId: string;
  readonly name: string | null;
  readonly accent: string | null;
}

/**
 * Keeps this device's account chooser up to date for the signed-in account (S38): remembered with
 * its current name and colour, unless the person chose "don't remember me" when signing in.
 */
export function AccountMemory({ userId, name, accent }: AccountMemoryProps) {
  useEffect(() => {
    if (rememberChoice()) rememberAccount({ userId, name, accent });
    else forgetAccount(userId);
  }, [userId, name, accent]);
  return null;
}
