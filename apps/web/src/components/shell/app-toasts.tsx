import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ToastProvider } from "@/components/ui/toast";

/**
 * The toast region for everything signed in: the app shell and Ora (S45 to S47), which sits beside
 * the shell, so the provider has to be above both (a guided change opened from Ora uses toasts).
 */
export function AppToasts({ children }: { readonly children: ReactNode }) {
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
      {children}
    </ToastProvider>
  );
}
