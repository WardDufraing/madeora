"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { clearAccountTabStorage } from "@/auth/tab-storage";
import { Button } from "@/components/ui/button";

/**
 * A real form POST to `/auth/sign-out`, so it also works before JavaScript has loaded. The server
 * ends the session at Supabase Auth and deletes the cookies. This tab drops its cached data at once;
 * the sign-in page it lands on then tells the other tabs (`AnnounceSignedOut`).
 */
export function SignOutButton({ variant = "ghost" }: { readonly variant?: "ghost" | "menu" }) {
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
        clearAccountTabStorage();
      }}
    >
      {variant === "menu" ? (
        <button
          type="submit"
          disabled={pending}
          className="flex min-h-10 w-full items-center rounded-control px-3 text-start text-body font-semibold text-fg hover:bg-accent-subtle"
        >
          {t("signOut")}
        </button>
      ) : (
        <Button type="submit" variant="ghost" size="sm" loading={pending}>
          {t("signOut")}
        </Button>
      )}
    </form>
  );
}
