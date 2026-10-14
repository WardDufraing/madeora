import Link from "next/link";
import { useTranslations } from "next-intl";

import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";

const linkBase =
  "inline-flex min-h-10 items-center justify-center rounded-control px-4 text-body font-medium transition-colors duration-(--md-duration-fast) ease-standard";

/**
 * The optional way into Homes for someone without one (spec, "Confirmed Home-independent adult
 * account onboarding"). It sits beside the widgets, never blocks personal use, and never creates a
 * Home by itself. Shown only while the person has no Home.
 */
export function HomeSetupCard() {
  const t = useTranslations("Dashboard");
  return (
    <Card title={t("homesTitle")}>
      <p className="mb-4 text-body text-fg-muted">{t("homesDescription")}</p>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/homes/new"
          className={cx(linkBase, "bg-accent text-on-accent hover:bg-accent-hover")}
        >
          {t("createHome")}
        </Link>
        <Link
          href="/homes/join"
          className={cx(
            linkBase,
            "border border-line-control bg-surface text-fg hover:bg-accent-subtle",
          )}
        >
          {t("joinHome")}
        </Link>
      </div>
    </Card>
  );
}
