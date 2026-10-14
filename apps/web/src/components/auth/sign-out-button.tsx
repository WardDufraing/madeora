"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * A real form POST to `/auth/sign-out`, so it also works before JavaScript has loaded. The server
 * ends the session at Supabase Auth and deletes the cookies. This tab drops its cached data at once;
 * the sign-in page it lands on then tells the other tabs (`AnnounceSignedOut`).
 */
export function SignOutButton() {
  const t = useTranslations("Auth");
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  return (
    <form
      method="post"
      action="/auth/sign-out"
      onSubmit={() => {
        setPending(true);
        queryClient.clear();
      }}
    >
      <Button type="submit" variant="ghost" size="sm" loading={pending}>
        {t("signOut")}
      </Button>
    </form>
  );
}
