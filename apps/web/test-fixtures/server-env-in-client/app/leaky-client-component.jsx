"use client";

// Deliberately wrong: browser code must never import server-only settings.
import { getServerEnv } from "@madeora/config/env/server";

export function LeakyClientComponent() {
  return <p>{getServerEnv().APP_ENV}</p>;
}
