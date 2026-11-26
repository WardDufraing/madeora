import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import type { MyHome } from "@/homes/types";
import type { SidebarState } from "@/preferences/preferences";

import { ContextSwitcher } from "./context-switcher";
import { FavoritesProvider } from "./favorites";
import { MobileNav } from "./mobile-nav";
import { NotificationBell } from "./notification-bell";
import { Sidebar } from "./sidebar";

export interface AppShellProps {
  readonly sidebar: SidebarState;
  /** The module shortcuts pinned on this device, `null` until the person chooses (defaults apply). */
  readonly favorites?: readonly string[] | null;
  /** The Homes the person belongs to, for the context switcher; `null` if they could not be read. */
  readonly homes: readonly MyHome[] | null;
  /** Unread notifications, for the bell (S14). */
  readonly unreadNotifications?: number;
  readonly children: ReactNode;
}

/**
 * The signed-in application frame: skip link, sidebar (desktop), top bar with the context
 * switcher slot and the small-screen menu, and the main landmark.
 */
export function AppShell({
  sidebar,
  favorites = null,
  homes,
  unreadNotifications = 0,
  children,
}: AppShellProps) {
  const t = useTranslations("Shell");
  const tAccounts = useTranslations("Accounts");

  return (
    <FavoritesProvider initial={favorites}>
      <a
        href="#main"
        className="fixed start-3 top-3 z-50 -translate-y-24 rounded-control bg-surface-elevated px-4 py-2 text-body font-semibold text-fg shadow-overlay focus-visible:translate-y-0"
      >
        {t("skipToContent")}
      </a>
      <div className="flex min-h-dvh">
        <Sidebar initialState={sidebar} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="relative flex h-20 items-center gap-3 px-4 md:px-8">
            {/* Personal or one Home (S09); the spec requires a clearly identified Personal
                context even with zero Homes. */}
            <ContextSwitcher homes={homes} />
            <div className="ms-auto flex items-center gap-1 rounded-pill border border-line bg-surface p-1 shadow-selected">
              <NotificationBell unread={unreadNotifications} />
              <Link
                href="/accounts"
                className="rounded-pill px-4 py-2 text-helper font-semibold text-fg hover:bg-accent-subtle"
                data-testid="switch-account-link"
              >
                {tAccounts("switchAccount")}
              </Link>
              <SignOutButton />
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 px-4 pb-24 md:px-8 focus:outline-none">
            {children}
          </main>
        </div>
      </div>
      <MobileNav />
    </FavoritesProvider>
  );
}
