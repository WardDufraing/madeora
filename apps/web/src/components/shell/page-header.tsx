import type { ReactNode } from "react";

import { cx } from "@/components/ui/cx";

export interface PageHeaderProps {
  readonly title: string;
  /** A quiet line under the title, such as today's date. */
  readonly subtitle?: ReactNode;
  /** Centred, for the welcome of a dashboard; every other page keeps the title at the start. */
  readonly centered?: boolean;
}

/** The page's single top-level heading. */
export function PageHeader({ title, subtitle, centered = false }: PageHeaderProps) {
  return (
    <div className={cx("mb-8 flex flex-col gap-1", centered && "items-center text-center")}>
      <h1 className={cx("font-bold", centered ? "text-4xl" : "text-page-title")}>{title}</h1>
      {subtitle ? <p className="text-body text-fg-muted">{subtitle}</p> : null}
    </div>
  );
}
