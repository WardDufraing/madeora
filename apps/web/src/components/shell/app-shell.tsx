import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ToastProvider } from "@/components/ui/toast";
import type { SidebarState } from "@/preferences/preferences";

import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";

export interface AppShellProps {
  readonly sidebar: SidebarState;
  readonly children: ReactNode;
}

/**
 * The signed-in application frame: skip link, sidebar (desktop), top bar with the context
 * switcher slot and the small-screen menu, and the main landmark.
 */
export function AppShell({ sidebar, children }: AppShellProps) {
  const t = useTranslations("Shell");
  const tComponents = useTranslations("Components");

  return (
    <ToastProvider
      regionLabel={tComponents("notifications")}
      dismissLabel={tComponents("dismiss")}
      toneLabels={{
        info: tComponents("toneInfo"),
        success: tComponents("toneSuccess"),
        warning: tComponents("toneWarning"),
        error: tComponents("toneError"),
      }}
    >
      <a
        href="#main"
        className="fixed start-3 top-3 z-50 -translate-y-24 rounded-control bg-surface-elevated px-4 py-2 text-body font-semibold text-fg shadow-overlay focus-visible:translate-y-0"
      >
        {t("skipToContent")}
      </a>
      <div className="flex min-h-dvh">
        <Sidebar initialState={sidebar} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 items-center gap-3 px-4 md:px-8">
            <MobileNav />
            {/* Context switcher slot. Only the Personal context exists until Homes do (S09);
                the spec requires a clearly identified Personal context even with zero Homes. */}
            <div className="flex items-center gap-2" role="group" aria-label={t("currentContext")}>
              <span className="rounded-control border border-line bg-surface px-3 py-1.5 text-body font-semibold text-fg">
                {t("personalContext")}
              </span>
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 px-4 pb-10 md:px-8 focus:outline-none">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
