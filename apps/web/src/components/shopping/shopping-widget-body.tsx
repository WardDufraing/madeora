"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";

import { accessAllows } from "@madeora/domain/permissions";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { useAnnouncer } from "@/components/ui/use-announcer";
import type { WidgetConfigs } from "@/dashboard/widgets";
import {
  sendShoppingRequest,
  shoppingItemEndpoint,
  SHOPPING_WIDGET_ENDPOINT,
  type ShoppingRequestError,
  type ShoppingWidgetData,
  type ShoppingWidgetItem,
} from "@/shopping/api";
import { shoppingKeys, shoppingListPath, shoppingPath } from "@/shopping/format";

import { QuickAdd } from "./quick-add";
import { ShoppingLive } from "./shopping-live";
import { useShoppingFailure, useShoppingTexts } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

export interface ShoppingWidgetBodyProps {
  readonly userId: string;
  readonly homeId: string | null;
  readonly config: WidgetConfigs["shopping"];
  readonly initial: ShoppingWidgetData;
  readonly contextId: string;
  readonly version: number;
}

function widgetUrl(homeId: string | null, config: WidgetConfigs["shopping"]): string {
  const params = new URLSearchParams({
    listIds: config.listIds.join(","),
    limit: String(config.count),
  });
  if (homeId) params.set("homeId", homeId);
  return `${SHOPPING_WIDGET_ENDPOINT}?${params.toString()}`;
}

/**
 * The widget's rows (S26): check off (when allowed), name, amount and, combining several lists,
 * the source list (with its place when names coincide); Open list; quick add to the configured
 * destination only, and only with edit access there. A selected list that is gone or no longer
 * visible is left out and said so. Live: re-read on the context's signal.
 */
export function ShoppingWidgetBody({
  userId,
  homeId,
  config,
  initial,
  contextId,
  version,
}: ShoppingWidgetBodyProps) {
  const t = useTranslations("ShoppingWidget");
  const texts = useShoppingTexts(useMemo(() => ({ byId: new Map(), selfId: null }), []));
  const { announce, region } = useAnnouncer();
  const query = useQuery<ShoppingWidgetData, ShoppingRequestError>({
    queryKey: shoppingKeys.widget(userId, homeId, config.listIds, config.count),
    queryFn: () => sendShoppingRequest("GET", widgetUrl(homeId, config)),
    initialData: initial,
    staleTime: Infinity,
    retry: false,
  });
  const data = query.data;
  const combined = data.lists.length > 1;
  const lists = new Map(data.lists.map((list) => [list.id, list]));
  const repeated = (name: string) => data.lists.filter((list) => list.name === name).length > 1;
  const destination = config.quickAddListId ? lists.get(config.quickAddListId) : undefined;
  const canQuickAdd =
    destination !== undefined && accessAllows(destination.access, false, "shopping.edit");
  const single = data.lists.length === 1 ? data.lists[0] : undefined;

  return (
    <HydrationGate>
      {region}
      <ShoppingLive contextId={contextId} version={version} refreshPage={false} />
      <div className="flex flex-col gap-3" data-testid="shopping-widget">
        {data.unavailable > 0 ? (
          <FormAlert tone="info">
            <span data-testid="shopping-widget-unavailable">{t("listUnavailable")}</span>
          </FormAlert>
        ) : null}
        {query.isError ? <p className="text-helper text-fg-muted">{t("staleNotice")}</p> : null}
        {data.items.length === 0 ? (
          <p className="text-body text-fg-muted">
            {data.lists.length === 0 ? t("noListsLeft") : t("nothingToBuy")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="shopping-widget-items">
            {data.items.map((item) => {
              const list = lists.get(item.listId);
              return (
                <WidgetRow
                  key={item.id}
                  item={item}
                  canCheck={list ? accessAllows(list.access, false, "shopping.check") : false}
                  amount={texts.amount(item.quantity, item.unit)}
                  source={
                    combined && list
                      ? repeated(list.name)
                        ? t("sourceWithPosition", { name: list.name, position: list.position + 1 })
                        : list.name
                      : null
                  }
                  announce={announce}
                />
              );
            })}
          </ul>
        )}
        {data.total > data.items.length ? (
          <p className="text-helper text-fg-muted">
            {t("more", { count: data.total - data.items.length })}
          </p>
        ) : null}
        {canQuickAdd ? (
          <div className="flex flex-col gap-1">
            {combined ? (
              <p className="text-helper text-fg-muted">
                {t("quickAddTo", { name: destination.name })}
              </p>
            ) : null}
            <QuickAdd
              listId={destination.id}
              onAdded={(name) => {
                announce(t("announceAdded", { name }));
              }}
            />
          </div>
        ) : null}
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {single ? (
            <Link
              href={shoppingListPath(homeId, single.id)}
              className="text-body font-medium text-accent-fg underline"
            >
              {t("openList")}
            </Link>
          ) : (
            data.lists.map((list) => (
              <Link
                key={list.id}
                href={shoppingListPath(homeId, list.id)}
                className="text-body font-medium text-accent-fg underline"
              >
                {t("openNamedList", { name: list.name })}
              </Link>
            ))
          )}
          {data.lists.length === 0 ? (
            <Link
              href={shoppingPath(homeId)}
              className="text-body font-medium text-accent-fg underline"
            >
              {t("openLists")}
            </Link>
          ) : null}
        </p>
      </div>
    </HydrationGate>
  );
}

function WidgetRow({
  item,
  canCheck,
  amount,
  source,
  announce,
}: {
  readonly item: ShoppingWidgetItem;
  readonly canCheck: boolean;
  readonly amount: string | null;
  readonly source: string | null;
  readonly announce: (message: string) => void;
}) {
  const shopping = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const check = useShoppingMutation(
    `shopping-item:${item.id}`,
    () =>
      sendShoppingRequest<object>("PUT", shoppingItemEndpoint(item.id, "completion"), {
        completed: true,
        seenCompletedAt: null,
      }),
    () => {
      announce(shopping("announceChecked", { name: item.name }));
    },
  );
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="shopping-widget-item">
      <input
        type="checkbox"
        className="size-5 shrink-0 accent-accent"
        checked={check.isPending || check.isSuccess}
        disabled={!canCheck || check.isPending || check.isSuccess}
        aria-label={shopping("checkItem", { name: item.name })}
        onChange={() => {
          check.mutate(undefined);
        }}
      />
      <span className="min-w-0 flex-1 text-body text-fg">
        {amount ? <span className="font-semibold">{amount} </span> : null}
        <bdi>{item.name}</bdi>
        {item.packaging ? (
          <span className="text-fg-muted">
            {" "}
            (<bdi>{item.packaging}</bdi>)
          </span>
        ) : null}
      </span>
      {source ? (
        <span className="text-helper text-fg-muted" data-testid="shopping-widget-source">
          <bdi>{source}</bdi>
        </span>
      ) : null}
      {check.error ? (
        <span className="w-full text-helper text-danger" role="alert">
          {failure(check.error.failure)}
        </span>
      ) : null}
    </li>
  );
}
