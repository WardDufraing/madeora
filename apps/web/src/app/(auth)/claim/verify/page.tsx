import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { transitionTokenSchema } from "@/child-transition/schema";
import { reviewTransition } from "@/child-transition/service";
import { FormAlert } from "@/components/auth/form-alert";
import { ClaimConfirm } from "@/components/child-transition/claim-confirm";
import { TransitionSummaryList } from "@/components/child-transition/transition-summary";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ChildTransition");
  return { title: await pageTitle(t("verifyTitle")) };
}

interface VerifyPageProps {
  readonly searchParams: Promise<{ readonly token?: string }>;
}

/**
 * The last step of claiming one's own account (S42 part 3), opened from the link emailed to the
 * young person's own address: the final review and the express confirmation.
 */
export default async function ClaimVerifyPage({ searchParams }: VerifyPageProps) {
  const [t, params] = await Promise.all([getTranslations("ChildTransition"), searchParams]);
  const token = transitionTokenSchema.safeParse(params.token);
  const review = token.success ? await reviewTransition(token.data) : null;

  return (
    <>
      <AuthPageTitle title={t("verifyTitle")} />
      {review === undefined ? (
        <FormAlert tone="info">{t("unavailable")}</FormAlert>
      ) : review === null || !token.success ? (
        <p className="text-body text-fg" data-testid="claim-invalid">
          {t("verifyInvalid")}
        </p>
      ) : review.completed ? (
        <ClaimConfirm token={token.data} email={null} alreadyDone />
      ) : (
        <div className="flex flex-col gap-6">
          <p className="text-body text-fg">{t("verifyIntro", { email: review.email ?? "" })}</p>
          <TransitionSummaryList summary={review} />
          <ClaimConfirm token={token.data} email={review.email} />
        </div>
      )}
    </>
  );
}
