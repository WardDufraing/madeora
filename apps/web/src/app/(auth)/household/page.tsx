import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { getAuthState } from "@/auth/identity";
import { currentDeviceHash } from "@/child-sign-in/device";
import { getHouseholdDeviceScreen } from "@/child-sign-in/service";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { HouseholdPinSignIn } from "@/components/child-sign-in/household-pin-sign-in";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ChildSignIn");
  return { title: await pageTitle(t("householdTitle")) };
}

/**
 * The PIN sign-in screen of an approved household device (S42; spec: PIN sign-in only on
 * explicitly approved household devices). Any other browser is told PIN sign-in is not available
 * here. Only the device's Home and the names of its children with PIN sign-in on are shown. A
 * child still signed in here is not taken back to their session: the screen always asks who is
 * signing in, and a new PIN sign-in replaces the earlier child's session (spec: a verified identity
 * is never silently kept for the next person).
 */
export default async function HouseholdPage() {
  const [state, t] = await Promise.all([getAuthState(), getTranslations("ChildSignIn")]);
  const deviceHash = await currentDeviceHash();
  const screen = deviceHash ? await getHouseholdDeviceScreen(deviceHash) : null;

  if (screen === undefined) {
    return (
      <>
        <AuthPageTitle title={t("householdTitle")} />
        <FormAlert tone="info">{t("unavailable")}</FormAlert>
      </>
    );
  }
  if (screen === null) {
    return (
      <>
        <AuthPageTitle title={t("householdTitle")} />
        <p className="text-body text-fg" data-testid="household-not-approved">
          {t("deviceNotApprovedText")}
        </p>
        <p className="mt-6 text-body">
          <Link href="/sign-in/child" className="font-medium text-accent-fg underline">
            {t("passwordSignInLink")}
          </Link>
        </p>
      </>
    );
  }
  return (
    <>
      <AuthPageTitle title={t("householdTitle")} />
      <p className="mb-5 text-body text-fg-muted">
        {t("householdIntro", { home: screen.homeName, device: screen.deviceLabel })}
      </p>
      {state.kind !== "signed-out" && state.kind !== "child" ? (
        <div className="flex flex-col gap-3">
          <FormAlert tone="info">{t("adultSignedInHere")}</FormAlert>
          {/* A plain form POST: this page has no client cache to clear, and the device comes
              straight back here for the child to choose their name. */}
          <form method="post" action="/auth/sign-out">
            <input type="hidden" name="then" value="household" />
            <Button type="submit" variant="secondary">
              {t("childSignOut")}
            </Button>
          </form>
        </div>
      ) : screen.children.length === 0 ? (
        <p className="text-body text-fg">{t("householdNoChildren")}</p>
      ) : (
        <HouseholdPinSignIn childrenOfHome={screen.children} />
      )}
      <p className="mt-6 text-body">
        <Link href="/household/chores" className="font-medium text-accent-fg underline">
          {t("choresLink")}
        </Link>
      </p>
    </>
  );
}
