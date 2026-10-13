import { useId, type ReactNode } from "react";

import { cx } from "./cx";

export interface CardProps {
  /** Card title. With a title, the card is a labelled region (`section`). */
  readonly title?: string;
  /** Heading level of the title in the page outline (default 2). */
  readonly headingLevel?: 2 | 3 | 4;
  readonly description?: ReactNode;
  /** A relevant action shown next to the title, such as a "View all" link. */
  readonly action?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * A surface for grouped content (spec: flat or very subtle elevation, restrained borders,
 * 14–18px radius, no glassmorphism, solid background — never a gradient).
 */
export function Card({
  title,
  headingLevel = 2,
  description,
  action,
  children,
  className,
}: CardProps) {
  const titleId = useId();
  const Heading = `h${String(headingLevel)}` as "h2" | "h3" | "h4";
  const Root = title ? "section" : "div";

  return (
    <Root
      aria-labelledby={title ? titleId : undefined}
      className={cx(
        "rounded-card border border-line bg-surface p-5 text-fg shadow-card sm:p-6",
        className,
      )}
    >
      {title || action ? (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            {title ? (
              <Heading id={titleId} className="text-section-title font-semibold">
                {title}
              </Heading>
            ) : null}
            {description ? <div className="text-helper text-fg-muted">{description}</div> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </Root>
  );
}
