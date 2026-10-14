import Link from "next/link";
import { useTranslations } from "next-intl";

import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/ui/states";

export interface HomePlaceholderProps {
  readonly title: string;
  readonly description: string;
}

/**
 * Where Create a Home and Join a Home lead until Homes are built (S09 and later). It says so
 * honestly and creates nothing; personal use carries on as before.
 */
export function HomePlaceholder({ title, description }: HomePlaceholderProps) {
  const t = useTranslations("Homes");
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        title={t("notBuiltTitle")}
        description={description}
        action={
          <Link href="/" className="text-body font-medium text-accent-fg underline">
            {t("backToDashboard")}
          </Link>
        }
      />
    </>
  );
}
