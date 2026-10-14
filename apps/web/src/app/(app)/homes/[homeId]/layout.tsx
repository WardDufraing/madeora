import type { ReactNode } from "react";

import { AccentStyle } from "@/components/accent/accent-style";
import { getHomeContext } from "@/homes/server";
import { getMyHomeProfile } from "@/members/profile";

interface HomeLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Every page of one Home (S11): inside a Home, Madeora takes the person's effective colour for
 * that Home. Without a Home override that is their global accent, which the app layout already
 * applies; with one, the override is rendered after it, so it wins here and disappears when they
 * leave the Home. Only for a confirmed current member; the pages themselves check the membership
 * again and redirect anyone else.
 */
export default async function HomeLayout({ children, params }: HomeLayoutProps) {
  const { homeId } = await params;
  const found = await getHomeContext(homeId);
  if (found.status !== "ok") return children;
  const profile = await getMyHomeProfile(found.context.home.id);
  return (
    <>
      <AccentStyle color={profile.status === "ok" ? profile.overrides.accentColor : null} />
      {children}
    </>
  );
}
