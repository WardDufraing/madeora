"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import {
  SHOPPING_WIDGET_LISTS,
  shoppingWidgetCounts,
  type WidgetConfigs,
} from "@/dashboard/widgets";
import {
  SHOPPING_LISTS_ENDPOINT,
  sendShoppingRequest,
  type ShoppingListSummary,
  type ShoppingRequestError,
} from "@/shopping/api";
import { shoppingKeys } from "@/shopping/format";

type Config = WidgetConfigs["shopping"];

/**
 * A Shopping widget's settings (S26): one list, or up to five combined, from the active lists the
 * viewer may see in the widget's context, in the order chosen; how many items; and where quick
 * add puts new items (one of the selected lists). A selected list that is gone is shown as such
 * until it is removed, never replaced. The server checks every id again on save and render.
 */
export function ShoppingWidgetSettings({
  config,
  homeId,
  onChange,
}: {
  readonly config: Config;
  readonly homeId: string | null;
  readonly onChange: (config: Config) => void;
}) {
  const t = useTranslations("ShoppingWidget");
  const options = useQuery<{ lists: readonly ShoppingListSummary[] }, ShoppingRequestError>({
    queryKey: [...shoppingKeys.all, "options", homeId ?? "personal"],
    queryFn: () =>
      sendShoppingRequest(
        "GET",
        homeId
          ? `${SHOPPING_LISTS_ENDPOINT}?homeId=${encodeURIComponent(homeId)}`
          : SHOPPING_LISTS_ENDPOINT,
      ),
    retry: false,
  });

  if (options.isPending) {
    return <p className="text-helper text-fg-muted">{t("settingsLoading")}</p>;
  }
  if (options.error) {
    return (
      <FormAlert tone="error" announce>
        {t("settingsFailed")}
      </FormAlert>
    );
  }
  const lists = options.data.lists;
  const byId = new Map(lists.map((list) => [list.id, list]));
  const label = (id: string) => {
    const list = byId.get(id);
    if (!list) return t("selectedUnavailable");
    return lists.filter((other) => other.name === list.name).length > 1
      ? t("sourceWithPosition", { name: list.name, position: list.position + 1 })
      : list.name;
  };
  const set = (next: Partial<Config>) => {
    const merged = { ...config, ...next };
    // Quick add stays among the selected lists.
    if (merged.quickAddListId !== null && !merged.listIds.includes(merged.quickAddListId)) {
      merged.quickAddListId = null;
    }
    onChange(merged);
  };
  const move = (index: number, by: -1 | 1) => {
    const ids = [...config.listIds];
    const [id] = ids.splice(index, 1);
    if (id === undefined) return;
    ids.splice(index + by, 0, id);
    set({ listIds: ids });
  };
  const unselected = lists.filter((list) => !config.listIds.includes(list.id));

  return (
    <div className="flex flex-col gap-4" data-testid="shopping-widget-settings">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-fg">{t("settingLists")}</legend>
        {config.listIds.length === 0 ? (
          <p className="text-helper text-fg-muted">{t("chooseLists")}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {config.listIds.map((id, index) => (
              <li key={id} className="flex flex-wrap items-center gap-1">
                <span className="min-w-0 flex-1 text-body text-fg">
                  <bdi>{label(id)}</bdi>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={t("moveSelectedUp", { name: label(id) })}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  {t("moveUp")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === config.listIds.length - 1}
                  aria-label={t("moveSelectedDown", { name: label(id) })}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  {t("moveDown")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t("removeSelected", { name: label(id) })}
                  onClick={() => {
                    set({ listIds: config.listIds.filter((other) => other !== id) });
                  }}
                >
                  {t("remove")}
                </Button>
              </li>
            ))}
          </ol>
        )}
        {config.listIds.length < SHOPPING_WIDGET_LISTS && unselected.length > 0 ? (
          <SelectField
            label={t("addList")}
            value=""
            options={[
              { value: "", label: t("addListPlaceholder") },
              ...unselected.map((list) => ({
                value: list.id,
                label:
                  lists.filter((other) => other.name === list.name).length > 1
                    ? t("sourceWithPosition", { name: list.name, position: list.position + 1 })
                    : list.name,
              })),
            ]}
            onChange={(event) => {
              const id = event.currentTarget.value;
              if (id !== "") set({ listIds: [...config.listIds, id] });
            }}
            data-testid="shopping-widget-add-list"
          />
        ) : config.listIds.length >= SHOPPING_WIDGET_LISTS ? (
          <p className="text-helper text-fg-muted">
            {t("listsFull", { max: SHOPPING_WIDGET_LISTS })}
          </p>
        ) : null}
      </fieldset>
      <SelectField
        label={t("settingCount")}
        value={String(config.count)}
        options={shoppingWidgetCounts.map((count) => ({
          value: String(count),
          label: t("settingCountOption", { count }),
        }))}
        onChange={(event) => {
          const count = Number(event.currentTarget.value);
          if (count === 5 || count === 10 || count === 15) set({ count });
        }}
      />
      <SelectField
        label={t("settingQuickAdd")}
        description={t("settingQuickAddHint")}
        value={config.quickAddListId ?? ""}
        options={[
          { value: "", label: t("settingQuickAddNone") },
          ...config.listIds
            .filter((id) => byId.has(id))
            .map((id) => ({ value: id, label: label(id) })),
        ]}
        onChange={(event) => {
          const id = event.currentTarget.value;
          set({ quickAddListId: id === "" ? null : id });
        }}
        data-testid="shopping-widget-quick-add"
      />
    </div>
  );
}
