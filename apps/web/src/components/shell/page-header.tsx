export interface PageHeaderProps {
  readonly title: string;
}

/** The page's single top-level heading. */
export function PageHeader({ title }: PageHeaderProps) {
  return <h1 className="mb-6 text-page-title font-semibold">{title}</h1>;
}
