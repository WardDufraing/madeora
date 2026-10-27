import { useTranslations } from "next-intl";

import type { RecipeSource as Source } from "@/recipes/schema";

/**
 * Where an imported recipe came from (S25): the site or author it credits and a link to the page.
 * Kept as it was imported; Madeora does not claim the content as its own. The link never sends the
 * Madeora page as referrer and is not endorsed.
 */
export function RecipeSource({ source }: { readonly source: Source }) {
  const t = useTranslations("Recipes");
  let host = source.url;
  try {
    host = new URL(source.url).hostname.replace(/^www\./u, "");
  } catch {
    // Stored URLs are checked http(s) addresses; the raw text is only a fallback.
  }
  // The credited name is free text, so the link also says where it really goes.
  const label = source.name && source.name !== host ? `${source.name} (${host})` : host;
  return (
    <p className="text-helper text-fg-muted" data-testid="recipe-source">
      {t("sourceLabel")}{" "}
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="font-medium text-accent-fg underline"
      >
        <bdi>{label}</bdi>
        <span className="sr-only"> {t("opensInNewTab")}</span>
      </a>
    </p>
  );
}
