import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { getShoppingContext, readShoppingWidget } from "@/shopping/data";
import { shoppingPath, signalContextId } from "@/shopping/format";

import { ShoppingWidgetBody } from "./shopping-widget-body";

/**
 * A Shopping widget (S26): the active items of its selected lists of one context (Personal space,
 * the Home, or a source Home), read with the viewer's session and kept live with the context's
 * signal. Nothing is shown from a list the viewer may not see now.
 */
export async function ShoppingWidget({
  homeId,
  config,
}: {
  readonly homeId: string | null;
  readonly config: WidgetConfigs["shopping"];
}) {
  const [{ userId }, t] = await Promise.all([requireIdentity(), getTranslations("ShoppingWidget")]);
  if (config.listIds.length === 0) {
    return (
      <div className="flex flex-col gap-2" data-testid="shopping-widget">
        <p className="text-body text-fg-muted">{t("chooseLists")}</p>
        <Link
          href={shoppingPath(homeId)}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("openLists")}
        </Link>
      </div>
    );
  }
  // The signal version is read before the content, so a change committed in between makes the
  // live view refresh once instead of being taken as already shown.
  const context = await getShoppingContext(homeId);
  const data = await readShoppingWidget(homeId, config.listIds, config.count);
  if (context.status !== "ok" || data.status !== "ok") {
    return <ErrorState title={t("failedTitle")} description={t("failed")} />;
  }
  return (
    <ShoppingWidgetBody
      userId={userId}
      homeId={homeId}
      config={config}
      initial={data.value}
      contextId={signalContextId(homeId, userId)}
      version={context.value.signalVersion}
    />
  );
}
