import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { transitionTokenSchema } from "@/child-transition/schema";
import { previewClaim } from "@/child-transition/service";
import { FormAlert } from "@/components/auth/form-alert";
import { ClaimForm } from "@/components/child-transition/claim-form";
import { TransitionSummaryList } from "@/components/child-transition/transition-summary";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ChildTransition");
  return { title: await pageTitle(t("claimTitle")) };
}

interface ClaimPageProps {
  readonly searchParams: Promise<{ readonly token?: string }>;
}

/**
 * Claiming one's own account (S42 part 3): opened from the link a guardian gave the young person.
 * They review what changes and give an email address they control; no sign-in is needed.
 */
export default async function ClaimPage({ searchParams }: ClaimPageProps) {
  const [t, params] = await Promise.all([getTranslations("ChildTransition"), searchParams]);
  const token = transitionTokenSchema.safeParse(params.token);
  const summary = token.success ? await previewClaim(token.data) : null;

  return (
    <>
      <AuthPageTitle title={t("claimTitle")} />
      {summary === undefined ? (
        <FormAlert tone="info">{t("unavailable")}</FormAlert>
      ) : summary === null || !token.success ? (
        <p className="text-body text-fg" data-testid="claim-invalid">
          {t("claimInvalid")}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          <p className="text-body text-fg">{t("claimIntro")}</p>
          <TransitionSummaryList summary={summary} />
          <ClaimForm token={token.data} />
        </div>
      )}
    </>
  );
}
