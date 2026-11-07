import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { getAuthState } from "@/auth/identity";
import { AccountChooser } from "@/components/account/account-chooser";
import { FormAlert } from "@/components/auth/form-alert";
import { pageTitle } from "@/i18n/page-title";

import { AuthPageTitle } from "../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Accounts");
  return { title: await pageTitle(t("title")) };
}

interface AccountsPageProps {
  readonly searchParams: Promise<{ readonly status?: string }>;
}

/**
 * The account chooser on this device (S38, spec "Confirmed secure multi-account switching on
 * ordinary shared devices"). Reachable signed in or out; shows only the remembered accounts'
 * names and colours, never their Homes, notifications or activity.
 */
export default async function AccountsPage({ searchParams }: AccountsPageProps) {
  const [t, params, state] = await Promise.all([
    getTranslations("Accounts"),
    searchParams,
    getAuthState(),
  ]);
  const activeUserId = state.kind === "signed-in" ? state.user.id : null;
  return (
    <>
      <AuthPageTitle title={t("title")} />
      {params.status === "removed" ? (
        <FormAlert tone="success" className="mb-4">
          {t("removedNotice")}
        </FormAlert>
      ) : null}
      <AccountChooser activeUserId={activeUserId} />
      <div className="mt-6 flex flex-col gap-2 text-helper text-fg-muted">
        <p>{t("explainSwitch")}</p>
        <p>{t("explainRemove")}</p>
        <p>{t("explainSignOut")}</p>
        <p>{t("explainShared")}</p>
      </div>
      {activeUserId ? (
        <p className="mt-6 text-body">
          <Link href="/" className="font-medium text-accent-fg underline">
            {t("back")}
          </Link>
        </p>
      ) : null}
    </>
  );
}
