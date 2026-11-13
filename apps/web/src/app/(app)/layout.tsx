import type { ReactNode } from "react";

import { touchMyActivity } from "@/activity/server";
import { requireIdentity } from "@/auth/identity";
import { AccountMemory } from "@/components/account/account-memory";
import { SecurityReviewBanner } from "@/components/account/security-review-banner";
import { AccentStyle } from "@/components/accent/accent-style";
import { AppProviders } from "@/components/auth/app-providers";
import { OraRoot } from "@/components/ora/ora-root";
import { AppShell } from "@/components/shell/app-shell";
import { listMyHomes } from "@/homes/server";
import { countUnreadNotifications } from "@/notifications/server";
import { getStoredPreferences } from "@/preferences/account";
import { getDevicePreferences } from "@/preferences/server";

/** Every page in this group needs a confirmed account (each page checks again, see requireIdentity). */
export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const identity = await requireIdentity();
  const [{ sidebar }, myHomes, stored, unread, reviewDue] = await Promise.all([
    getDevicePreferences(),
    listMyHomes(),
    getStoredPreferences(),
    countUnreadNotifications(),
    // S38: this visit is account activity (inactivity reminders); a review may be due on return.
    touchMyActivity(),
  ]);
  // The person's global accent (S11) colours the app; a Home's layout may override it inside that
  // Home. Account state, so it is read per request and never cached across people.
  return (
    <AppProviders userId={identity.userId}>
      <AccentStyle color={stored.accentColor} />
      <AccountMemory
        userId={identity.userId}
        name={stored.displayName ?? null}
        accent={stored.accentColor ?? null}
      />
      <AppShell
        sidebar={sidebar}
        homes={myHomes.status === "ok" ? myHomes.homes : null}
        unreadNotifications={unread}
      >
        {reviewDue ? <SecurityReviewBanner /> : null}
        {children}
      </AppShell>
      {/* Ora (S45): its own settings decide whether it shows; the rest of the app never waits on it. */}
      <OraRoot
        userId={identity.userId}
        homes={myHomes.status === "ok" ? myHomes.homes.map(({ id, name }) => ({ id, name })) : null}
      />
    </AppProviders>
  );
}
