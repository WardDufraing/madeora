import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { AllModules } from "@/components/shell/all-modules";
import { PageHeader } from "@/components/shell/page-header";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Modules");
  return { title: await pageTitle(t("title")) };
}

/** Every module in the Personal space, searchable, with pinning for the shortcuts. */
export default async function PersonalModulesPage() {
  const [{ userId }, t] = await Promise.all([requireIdentity(), getTranslations("Modules")]);
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <PageHeader title={t("title")} />
      <p className="-mt-4 mb-6 max-w-prose text-body text-fg-muted">
        {t("description", { context: t("contextPersonal") })}
      </p>
      <AllModules homeId={null} />
    </>
  );
}
