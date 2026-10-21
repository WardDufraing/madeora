import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { cx } from "@/components/ui/cx";
import { tasksPath } from "@/tasks/format";

/**
 * List / Calendar (S19c): the calendar is an optional second view of the same tasks; the list stays
 * the default and nothing needs the calendar. `list` keeps the chosen list across the switch.
 */
export async function TaskViewSwitch({
  homeId,
  current,
  list,
}: {
  readonly homeId: string | null;
  readonly current: "list" | "calendar";
  readonly list?: string | undefined;
}) {
  const t = await getTranslations("TaskCalendar");
  const base = tasksPath(homeId);
  const suffix = list ? `?list=${list}` : "";
  const item = (view: "list" | "calendar", href: string, label: string) => (
    <li>
      <Link
        href={href}
        aria-current={current === view ? "page" : undefined}
        className={cx(
          "inline-flex min-h-10 items-center rounded-control px-3 text-body font-medium",
          current === view ? "bg-accent-subtle text-fg" : "text-accent-fg underline",
        )}
      >
        {label}
      </Link>
    </li>
  );
  return (
    <nav aria-label={t("viewSwitch")} className="mb-4" data-testid="task-view-switch">
      <ul className="flex flex-wrap gap-2">
        {item("list", `${base}${suffix}`, t("viewList"))}
        {item("calendar", `${base}/calendar${suffix}`, t("viewCalendar"))}
      </ul>
    </nav>
  );
}
