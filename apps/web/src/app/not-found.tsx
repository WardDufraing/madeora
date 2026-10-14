import { getTranslations } from "next-intl/server";

import { pageTitle } from "@/i18n/page-title";

/** Any other unknown address, outside the app shell, in the interface language. */
export default async function NotFound() {
  const t = await getTranslations("NotFound");
  // Next.js does not apply a not-found file's metadata when a page calls notFound(), so the
  // title is rendered here; React places it in <head>.
  const title = await pageTitle(t("title"));
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4">
      <title>{title}</title>
      <h1 className="text-page-title font-semibold">{t("title")}</h1>
      <p className="text-body text-fg-muted">{t("description")}</p>
    </main>
  );
}
