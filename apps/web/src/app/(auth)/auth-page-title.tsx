export interface AuthPageTitleProps {
  readonly title: string;
}

/** The page's single top-level heading inside the auth card. */
export function AuthPageTitle({ title }: AuthPageTitleProps) {
  return <h1 className="mb-5 text-page-title font-semibold">{title}</h1>;
}
