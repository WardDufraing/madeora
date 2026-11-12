import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { getAuthState } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { DisplayPairing } from "@/components/displays/display-pairing";
import { DisplayReset } from "@/components/displays/display-reset";
import { PairedDisplay } from "@/components/displays/paired-display";
import { Button } from "@/components/ui/button";
import { getDisplaySession } from "@/displays/server";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Displays");
  return { title: await pageTitle(t("screenTitle")) };
}

/**
 * A Household Display's only page (S43).
 *
 * - Unregistered (no session): the pairing screen, with pairing instructions and the temporary
 *   code only (spec: no Home information or household controls before approval).
 * - Paired: the display's own screen. S43 shows its name, its Home's name and the time; the shared
 *   dashboard follows in S44. A display the database no longer accepts (revoked, Home closed) is
 *   signed out and shows the pairing screen again, without anything it showed before.
 * - Someone's own session in this browser: pairing never replaces it, so they are asked to sign out.
 */
export default async function DisplayPage() {
  const [state, t] = await Promise.all([getAuthState(), getTranslations("Displays")]);

  if (state.kind === "display") {
    const result = await getDisplaySession();
    if (result.kind === "refused") return <DisplayReset />;
    if (result.kind === "unavailable") {
      return (
        <FormAlert tone="info" className="w-full max-w-md text-start">
          {t("screenUnavailable")}
        </FormAlert>
      );
    }
    return (
      <PairedDisplay
        displayName={result.session.displayName}
        homeName={result.session.homeName}
        timeZone={result.session.homeTimezone}
      />
    );
  }

  if (state.kind === "signed-out") return <DisplayPairing />;

  return (
    <div className="flex w-full max-w-md flex-col gap-4 text-start">
      <h1 className="text-page-title font-semibold text-fg">{t("screenTitle")}</h1>
      <FormAlert tone="info">{t("signedInHere")}</FormAlert>
      {/* A plain form POST: the browser comes straight back here to show the pairing code. */}
      <form method="post" action="/auth/sign-out">
        <input type="hidden" name="then" value="display" />
        <Button type="submit" variant="secondary">
          {t("signOutFirst")}
        </Button>
      </form>
    </div>
  );
}
