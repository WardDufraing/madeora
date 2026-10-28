import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { hasTrashFilters, type TrashFilters } from "@/trash/filters";
import { trashItemTypes, trashModules } from "@/trash/schema";

export interface TrashFiltersFormProps {
  /** The page the form submits to (it is a plain GET, so it works before any script runs). */
  readonly action: string;
  readonly filters: TrashFilters;
}

const moduleKey = {
  sample: "moduleSample",
  dashboard: "moduleDashboard",
  tasks: "moduleTasks",
  chores: "moduleChores",
  recipes: "moduleRecipes",
  shopping: "moduleShopping",
  meals: "moduleMeals",
  habits: "moduleHabits",
} as const;
const itemTypeKey = {
  sample: "itemTypeSample",
  dashboard_template: "itemTypeDashboardTemplate",
  task: "itemTypeTask",
  task_list: "itemTypeTaskList",
  task_series_removal: "itemTypeTaskSeriesRemoval",
  task_attachment: "itemTypeTaskAttachment",
  task_series_attachment: "itemTypeTaskSeriesAttachment",
  chore: "itemTypeChore",
  chore_occurrence: "itemTypeChoreOccurrence",
  chore_removal: "itemTypeChoreRemoval",
  recipe: "itemTypeRecipe",
  shopping_list: "itemTypeShoppingList",
  shopping_item: "itemTypeShoppingItem",
  shopping_clear: "itemTypeShoppingClear",
  meal_entry: "itemTypeMealEntry",
  habit: "itemTypeHabit",
} as const;

/** Filters by module, item type and deletion date (spec: the central trash view offers all three). */
export async function TrashFiltersForm({ action, filters }: TrashFiltersFormProps) {
  const t = await getTranslations("Trash");
  return (
    <form
      method="get"
      action={action}
      aria-label={t("filtersLabel")}
      className="mb-6 grid max-w-3xl gap-4 sm:grid-cols-2"
    >
      <SelectField
        label={t("filterModule")}
        name="module"
        defaultValue={filters.module}
        options={[
          { value: "", label: t("filterAll") },
          ...trashModules.map((value) => ({ value, label: t(moduleKey[value]) })),
        ]}
      />
      <SelectField
        label={t("filterItemType")}
        name="type"
        defaultValue={filters.itemType}
        options={[
          { value: "", label: t("filterAll") },
          ...trashItemTypes.map((value) => ({ value, label: t(itemTypeKey[value]) })),
        ]}
      />
      <TextField label={t("filterFrom")} name="from" type="date" defaultValue={filters.from} />
      <TextField label={t("filterTo")} name="to" type="date" defaultValue={filters.to} />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="secondary">
          {t("filterApply")}
        </Button>
        {hasTrashFilters(filters) ? (
          <Link href={action} className="text-body font-medium text-accent-fg underline">
            {t("filterClear")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
