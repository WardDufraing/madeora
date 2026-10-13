import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { pageTitle } from "@/i18n/page-title";

/** Shown inside the app shell when a page calls notFound(), in the interface language. */
export default async function AppNotFound() {
  const t = await getTranslations("NotFound");
  // Next.js does not apply a not-found file's metadata when a page calls notFound(), so the
  // title is rendered here; React places it in <head>.
  const title = await pageTitle(t("title"));
  return (
    <>
      <title>{title}</title>
      <PageHeader title={t("title")} />
      <p className="text-body text-fg-muted">{t("description")}</p>
    </>
  );
}
