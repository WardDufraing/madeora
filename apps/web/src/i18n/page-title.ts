import { getTranslations } from "next-intl/server";

/**
 * The document title for a page, such as "Instellingen · Madeora", in the interface language.
 * Every page sets its own full title: the root layout has none, so a not-found page, whose
 * metadata Next.js does not apply when a page calls notFound(), never shows a competing title.
 */
export async function pageTitle(page: string): Promise<string> {
  const t = await getTranslations("Metadata");
  return t("pageTitle", { page });
}
