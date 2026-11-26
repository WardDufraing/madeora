import type { ReactNode } from "react";

export interface PageHeaderProps {
  readonly title: string;
  /** A quiet line under the title, such as today's date. */
  readonly subtitle?: ReactNode;
}

/** The page's single top-level heading. */
export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <div className="mb-8 flex flex-col gap-1">
      <h1 className="text-page-title font-bold">{title}</h1>
      {subtitle ? <p className="text-body text-fg-muted">{subtitle}</p> : null}
    </div>
  );
}
