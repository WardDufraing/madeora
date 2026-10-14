import { renderAccentCss } from "@madeora/design-tokens";

import type { AccentColor } from "@/accent/accent";

/**
 * Applies a person's accent to the page (S11): a style sheet that overrides the default accent
 * tokens in every theme. The Personal context renders the global accent; a Home's layout renders
 * the effective accent for that Home after it, which wins inside the Home. `null` keeps the
 * default. `renderAccentCss` only accepts a validated solid colour and emits fixed selectors with
 * derived hex values, so nothing a person typed can reach the style sheet as text.
 */
export function AccentStyle({ color }: { readonly color: AccentColor | null }) {
  if (color === null) return null;
  return <style data-accent={color} dangerouslySetInnerHTML={{ __html: renderAccentCss(color) }} />;
}
