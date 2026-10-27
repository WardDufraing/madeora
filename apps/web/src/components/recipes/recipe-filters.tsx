import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { RecipeTag } from "@/recipes/api";
import {
  RECIPE_FIELD_LIMITS,
  recipeSorts,
  type RecipeQuery,
  type RecipeSort,
} from "@/recipes/schema";

export interface RecipeFiltersProps {
  readonly action: string;
  readonly query: RecipeQuery;
  readonly tags: readonly RecipeTag[];
  readonly filtered: boolean;
}

const sortKey = {
  name_asc: "sortNameAsc",
  name_desc: "sortNameDesc",
  added_desc: "sortAddedDesc",
  added_asc: "sortAddedAsc",
  updated_desc: "sortUpdatedDesc",
  updated_asc: "sortUpdatedAsc",
} as const;

/**
 * The library's search, tag filter (recipes with every selected tag), Favorites and sort (S24). A
 * plain GET form: it works without JavaScript, lives in the URL and changes only this person's view.
 */
export async function RecipeFilters({ action, query, tags, filtered }: RecipeFiltersProps) {
  const t = await getTranslations("Recipes");
  return (
    <form
      method="get"
      action={action}
      role="search"
      aria-label={t("filtersLabel")}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      data-testid="recipe-filters"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="search"
          name="q"
          label={t("searchLabel")}
          description={t("searchHelp")}
          defaultValue={query.q}
          maxLength={RECIPE_FIELD_LIMITS.query}
          autoComplete="off"
        />
        <SelectField
          label={t("sortLabel")}
          name="sort"
          defaultValue={query.sort}
          options={recipeSorts.map((sort) => {
            const key: (typeof sortKey)[RecipeSort] = sortKey[sort];
            return { value: sort, label: t(key) };
          })}
        />
      </div>
      {tags.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium text-fg">{t("tagFilterLabel")}</legend>
          <p className="text-helper text-fg-muted">{t("tagFilterHelp")}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {tags.map((tag) => (
              <Checkbox
                key={tag.tag}
                name="tag"
                value={tag.tag}
                label={t("tagWithCount", { tag: tag.tag, count: tag.count })}
                defaultChecked={query.tags.includes(tag.tag)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      <Checkbox
        name="favorites"
        value="1"
        label={t("favoritesOnly")}
        defaultChecked={query.favorites}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary">
          {t("applyFilters")}
        </Button>
        {filtered ? (
          <Link href={action} className="text-body font-medium text-accent-fg underline">
            {t("clearFilters")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
