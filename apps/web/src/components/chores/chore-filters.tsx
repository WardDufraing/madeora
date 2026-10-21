import { useTranslations } from "next-intl";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import type { OverviewQuery } from "@/chores/schema";
import type { MemberOption } from "@/tasks/format";

export interface ChoreFiltersProps {
  readonly action: string;
  readonly query: OverviewQuery;
  readonly members: readonly MemberOption[];
  /** Every category, archived ones too: their chores still show. */
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly filtered: boolean;
}

/**
 * The chores overview's filters (S20): assignee (me, anyone, unassigned or one member) and category
 * (with Uncategorized). A plain GET form: it works without JavaScript, lives in the URL and changes
 * only this person's view.
 */
export function ChoreFilters({ action, query, members, categories, filtered }: ChoreFiltersProps) {
  const t = useTranslations("Chores");
  return (
    <form
      method="get"
      action={action}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      aria-label={t("filtersLabel")}
      data-testid="chore-filters"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label={t("filterAssignee")}
          name="assignee"
          defaultValue={query.assignee === "member" && query.member ? query.member : query.assignee}
          options={[
            { value: "any", label: t("assigneeAny") },
            { value: "me", label: t("assigneeMe") },
            { value: "unassigned", label: t("assigneeUnassigned") },
            ...members
              .filter((member) => !member.isSelf)
              .map((member) => ({ value: member.id, label: member.name ?? t("personUnnamed") })),
          ]}
        />
        <SelectField
          label={t("filterCategory")}
          name="category"
          defaultValue={query.category}
          options={[
            { value: "any", label: t("categoryAny") },
            { value: "none", label: t("uncategorized") },
            ...categories.map((category) => ({ value: category.id, label: category.name })),
          ]}
        />
      </div>
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
