import type { ChildCapability } from "@madeora/domain/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { requireChildIdentity } from "@/auth/identity";
import { CHILD_SIGN_IN_PATH } from "@/auth/redirects";
import { getChildSession } from "@/child-sign-in/server";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ChildSignIn");
  return { title: await pageTitle(t("childHomeTitle")) };
}

/**
 * A signed-in child's page (S42): the Homes this session reaches and, for each, what the child's
 * guardians allow there, in plain words. Module pages for children arrive with later steps; until
 * then this is all a child's session can see (the database refuses everything else).
 */
export default async function ChildHomePage() {
  await requireChildIdentity();
  const [session, t, formats] = await Promise.all([
    getChildSession(),
    getTranslations("ChildSignIn"),
    getDateTimeFormats(),
  ]);
  // Ended, expired or turned off by a guardian: sign out properly.
  if (!session) redirect(`${CHILD_SIGN_IN_PATH}?status=ended`);
  const firstName = session.homes.find((home) => home.displayName)?.displayName ?? null;
  const capabilityText = (capability: ChildCapability) => t(`capability.${capability}`);

  return (
    <>
      <h1 className="text-page-title font-semibold text-fg">
        {firstName ? t("childHello", { name: firstName }) : t("childHelloNoName")}
      </h1>
      <p className="text-body text-fg-muted" data-testid="child-session-info">
        {session.method === "pin"
          ? t("childSessionPin", { time: formatDateTime(session.expiresAt, formats) })
          : t("childSessionPassword", { time: formatDateTime(session.expiresAt, formats) })}
      </p>
      {session.homes.map((home) => (
        <Card key={home.homeId} title={home.homeName} headingLevel={2}>
          <p className="mb-3 text-body text-fg">{t("childCanDo")}</p>
          {home.capabilities.length === 0 ? (
            <p className="text-body text-fg-muted">{t("childNothingYet")}</p>
          ) : (
            <ul className="list-disc ps-6 text-body text-fg" data-testid="child-capabilities">
              {home.capabilities.map((capability) => (
                <li key={capability}>{capabilityText(capability)}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-helper text-fg-muted">{t("childComingSoon")}</p>
        </Card>
      ))}
      <form method="post" action="/auth/sign-out">
        <input type="hidden" name="then" value={session.method === "pin" ? "household" : "child"} />
        <Button type="submit" variant="secondary">
          {t("childSignOut")}
        </Button>
      </form>
    </>
  );
}
