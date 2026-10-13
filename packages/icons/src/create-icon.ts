import { iconSize, type IconSize } from "@madeora/design-tokens";
import { createElement, type ReactElement } from "react";

import type { IconElement } from "../scripts/parse-svg.ts";

export type { IconElement } from "../scripts/parse-svg.ts";

export interface IconProps {
  /** Rendered size: sm 16px, md 20px (default), lg 24px. */
  readonly size?: IconSize;
  /**
   * Accessible name. Leave it out for decorative icons (the usual case: the control or text next
   * to the icon carries the meaning); they are then hidden from assistive technology.
   */
  readonly title?: string;
  readonly className?: string;
}

export type IconComponent = ((props: IconProps) => ReactElement) & { displayName: string };

/** Builds an inline SVG icon from vetted shapes. Colour comes from `currentColor` only. */
export function createIcon(name: string, elements: readonly IconElement[]): IconComponent {
  function Icon({ size = "md", title, className }: IconProps): ReactElement {
    const px = iconSize[size];
    const label = title?.trim();
    return createElement(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: px,
        height: px,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        focusable: "false",
        className,
        ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true }),
      },
      ...elements.map(([tag, attributes], index) =>
        createElement(tag, { key: index, ...attributes }),
      ),
    );
  }
  Icon.displayName = `${name}Icon`;
  return Icon;
}
