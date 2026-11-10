import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { ACTIVITY_CATEGORIES, ACTIVITY_OUTCOMES } from "@/activity/catalogue";
import { hasActivityFilters, MAX_QUERY_LENGTH, type ActivityFilters } from "@/activity/filters";
import type { ActivityHome } from "@/activity/server";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";

export interface ActivityFiltersFormProps {
  /** The page the form submits to (a plain GET, so it works before any script runs). */
  readonly action: string;
  readonly filters: ActivityFilters;
  readonly homes: readonly ActivityHome[];
  /** The Security activity page: the category is fixed and there is no Home filter. */
  readonly securityOnly?: boolean;
}

/**
 * Search and filters for the person's own history (spec: keyword search over redacted labels and
 * permitted metadata, category and outcome filters, date range, Home filter; accessible reset).
 */
export async function ActivityFiltersForm({
  action,
  filters,
  homes,
  securityOnly = false,
}: ActivityFiltersFormProps) {
  const t = await getTranslations("Activity");
  return (
    <form
      method="get"
      action={action}
      role="search"
      aria-label={t("filtersLabel")}
      className="mb-6 grid max-w-3xl gap-4 sm:grid-cols-2"
    >
      <div className="sm:col-span-2">
        <TextField
          label={t("filterSearch")}
          description={t("filterSearchHint")}
          name="q"
          type="search"
          maxLength={MAX_QUERY_LENGTH}
          defaultValue={filters.q}
        />
      </div>
      {securityOnly ? null : (
        <SelectField
          label={t("filterCategory")}
          name="category"
          defaultValue={filters.category}
          options={[
            { value: "", label: t("filterAll") },
            ...ACTIVITY_CATEGORIES.map((value) => ({ value, label: t(`category.${value}`) })),
          ]}
        />
      )}
      <SelectField
        label={t("filterOutcome")}
        name="outcome"
        defaultValue={filters.outcome}
        options={[
          { value: "", label: t("filterAll") },
          ...ACTIVITY_OUTCOMES.map((value) => ({ value, label: t(`outcome.${value}`) })),
        ]}
      />
      {securityOnly || homes.length === 0 ? null : (
        <SelectField
          label={t("filterHome")}
          name="home"
          defaultValue={filters.home}
          options={[
            { value: "", label: t("filterAll") },
            ...homes.map((home) => ({ value: home.id, label: home.name })),
          ]}
        />
      )}
      <TextField label={t("filterFrom")} name="from" type="date" defaultValue={filters.from} />
      <TextField label={t("filterTo")} name="to" type="date" defaultValue={filters.to} />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="secondary">
          {t("filterApply")}
        </Button>
        {hasActivityFilters(filters) ? (
          <Link href={action} className="text-body font-medium text-accent-fg underline">
            {t("filterClear")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
