import { getTranslations } from "next-intl/server";

import { FormAlert } from "@/components/auth/form-alert";
import {
  availableBytes,
  countedBytes,
  formatBytes,
  percentUsed,
  warningLevel,
  type StorageUsage,
} from "@/storage/usage-view";

export interface StorageUsageViewProps {
  readonly usage: StorageUsage;
  readonly locale: string;
  /** Which pool this is, for the words: the person's own or a Home's. */
  readonly pool: "personal" | "home";
}

/**
 * One storage pool (S15; spec "Confirmed progressive storage warnings"): used, available and total,
 * how much recently deleted files still hold, and a warning at 80% (gentle) and 95% (prominent)
 * that never blocks anything else. Full storage explains what still works. The bar is decorative;
 * the numbers are the content, so nothing relies on colour or the bar alone.
 */
export async function StorageUsageView({ usage, locale, pool }: StorageUsageViewProps) {
  const t = await getTranslations("Storage");
  const percent = percentUsed(usage);
  const level = warningLevel(usage);
  const format = (bytes: number) => formatBytes(bytes, locale);

  return (
    <div className="flex flex-col gap-4" data-testid={`storage-usage-${pool}`}>
      <p className="text-section-title font-semibold text-fg" data-testid="storage-summary">
        {t("summary", {
          used: format(countedBytes(usage)),
          total: format(usage.allowance),
          percent,
        })}
      </p>
      <div
        aria-hidden="true"
        className="h-3 w-full overflow-hidden rounded-full border border-line-control bg-surface-sunken"
      >
        <div
          className={
            level === "none"
              ? "h-full bg-accent"
              : level === "warning"
                ? "h-full bg-warning"
                : "h-full bg-danger"
          }
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-body sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-fg-muted">{t("inUse")}</dt>
          <dd className="font-medium text-fg" data-testid="storage-in-use">
            {format(usage.used)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-fg-muted">{t("recentlyDeleted")}</dt>
          <dd className="font-medium text-fg" data-testid="storage-deleted">
            {format(usage.deleted)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-fg-muted">{t("available")}</dt>
          <dd className="font-medium text-fg" data-testid="storage-available">
            {format(availableBytes(usage))}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-fg-muted">{t("total")}</dt>
          <dd className="font-medium text-fg">{format(usage.allowance)}</dd>
        </div>
      </dl>
      <p className="text-helper text-fg-muted">{t("deletedHint")}</p>
      {level === "warning" ? (
        <FormAlert tone="info">
          <p data-testid="storage-warning">
            {t(pool === "personal" ? "warningPersonal" : "warningHome")}
          </p>
        </FormAlert>
      ) : level === "critical" ? (
        <FormAlert tone="error">
          <p data-testid="storage-critical">
            {t(pool === "personal" ? "criticalPersonal" : "criticalHome")}
          </p>
        </FormAlert>
      ) : level === "full" ? (
        <FormAlert tone="error">
          <p data-testid="storage-full">{t(pool === "personal" ? "fullPersonal" : "fullHome")}</p>
        </FormAlert>
      ) : null}
    </div>
  );
}
