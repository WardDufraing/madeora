"use client";

import { getPublicEnv } from "@madeora/config/env/public";

export function PublicClientComponent() {
  return <p>{getPublicEnv().NEXT_PUBLIC_APP_URL}</p>;
}
