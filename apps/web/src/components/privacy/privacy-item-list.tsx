import { useTranslations } from "next-intl";
import Link from "next/link";

import type { PrivacyItem } from "@/privacy/items";

/**
 * Summarised privacy settings (S39): each with its scope label (account-wide, Home-specific,
 * device-specific), current value, who can see or change it, and a link to the setting itself.
 * Shared by the privacy dashboard and the guided review.
 */
export function PrivacyItemList({ items }: { readonly items: readonly PrivacyItem[] }) {
  const t = useTranslations("Privacy");
  return (
    <ul className="flex flex-col divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-1 py-3" data-testid="privacy-item">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-body font-medium">{item.title}</span>
            <span className="rounded-full border border-line px-2 text-helper text-fg-muted">
              {t(`scope.${item.scope}`)}
            </span>
          </div>
          <p className="text-body">{item.value ?? t("valueUnavailable")}</p>
          <p className="text-helper text-fg-muted">{item.who}</p>
          {item.href ? (
            <p>
              <Link href={item.href} className="text-helper font-medium text-accent-fg underline">
                {t("openSetting", { setting: item.title })}
              </Link>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
