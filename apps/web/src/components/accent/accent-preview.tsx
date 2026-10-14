"use client";

import { renderAccentCss } from "@madeora/design-tokens";
import { useId, type ReactNode } from "react";

import type { AccentColor } from "@/accent/accent";

/**
 * Draws its children with `color` as the accent, in whichever theme is showing, by scoping the
 * derived accent tokens to this element (S11 previews). Children use the ordinary accent token
 * utilities (`bg-accent`, `text-on-accent`, ...). Only a validated colour reaches the style sheet,
 * and the scope is built from React's id with anything but letters, digits, `_` and `-` removed.
 */
export function AccentPreview({
  color,
  className,
  children,
}: {
  /** The colour to preview, or `null` for the default accent of the theme on screen. */
  readonly color: AccentColor | null;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const scope = useId().replace(/[^\w-]/g, "");
  return (
    <span data-accent-preview={scope} className={className}>
      <style
        dangerouslySetInnerHTML={{
          __html: renderAccentCss(color, `[data-accent-preview="${scope}"]`),
        }}
      />
      {children}
    </span>
  );
}
