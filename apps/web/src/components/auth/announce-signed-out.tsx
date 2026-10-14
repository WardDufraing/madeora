"use client";

import { useEffect } from "react";

import { announceSignedOut } from "@/auth/broadcast";

/**
 * Rendered on the page someone lands on after signing out. By then the server has deleted the
 * session cookies, so other tabs that re-check access straight away are sent to sign-in.
 */
export function AnnounceSignedOut() {
  useEffect(() => {
    announceSignedOut();
  }, []);
  return null;
}
