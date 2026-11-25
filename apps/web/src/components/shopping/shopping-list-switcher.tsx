"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { AdaptiveSwitcher } from "@/components/ui/adaptive-switcher";
import { shoppingListPath } from "@/shopping/format";

import { NewListButton } from "./list-actions";

export interface SwitcherList {
  readonly id: string;
  readonly name: string;
  /** Items still to buy. */
  readonly activeItems: number;
}

/**
 * The list switcher of the shopping workspace (redesign decision 71): a few lists as chips, many
 * as a searchable picker, a compact picker on narrow screens. Switching opens that list's page.
 * Labels carry the items left to buy; lists that share a name are told apart by their position.
 * + New list is always next to it, for people who may create lists.
 */
export function ShoppingListSwitcher({
  lists,
  currentId,
  homeId,
  canCreate,
}: {
  readonly lists: readonly SwitcherList[];
  readonly currentId: string;
  readonly homeId: string | null;
  readonly canCreate: boolean;
}) {
  const t = useTranslations("Shopping");
  const router = useRouter();
  const counts = new Map<string, number>();
  for (const list of lists) counts.set(list.name, (counts.get(list.name) ?? 0) + 1);
  const items = lists.map((list, index) => ({
    id: list.id,
    label: [
      list.name,
      (counts.get(list.name) ?? 0) > 1 ? `#${String(index + 1)}` : null,
      list.activeItems > 0 ? `(${String(list.activeItems)})` : null,
    ]
      .filter((part) => part !== null)
      .join(" "),
  }));
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="shopping-list-switcher">
      {items.length > 0 ? (
        <AdaptiveSwitcher
          label={t("switcherLabel")}
          items={items}
          value={currentId}
          onChange={(id) => {
            router.push(shoppingListPath(homeId, id));
          }}
          searchLabel={t("switcherSearch")}
          noResultsLabel={t("switcherNoResults")}
          pickerLabel={t("switcherPicker")}
        />
      ) : null}
      {canCreate ? <NewListButton homeId={homeId} /> : null}
    </div>
  );
}
