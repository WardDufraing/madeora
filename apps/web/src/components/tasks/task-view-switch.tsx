import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { cx } from "@/components/ui/cx";
import { tasksPath } from "@/tasks/format";
import { taskViews, viewHref, type TaskView } from "@/tasks/views";

/**
 * Today / Upcoming / All tasks / Lists, and the Calendar as a further view of the same tasks
 * (redesign decision 46, S19c). Today is where the page starts. `list` keeps the chosen list across
 * the switch to the Calendar and back.
 */
export async function TaskViewSwitch({
  homeId,
  current,
  list,
}: {
  readonly homeId: string | null;
  readonly current: TaskView | "calendar";
  readonly list?: string | undefined;
}) {
  const t = await getTranslations("TaskCalendar");
  const tTasks = await getTranslations("Tasks");
  const label: Record<TaskView, string> = {
    today: tTasks("viewToday"),
    upcoming: tTasks("viewUpcoming"),
    all: tTasks("viewAll"),
    lists: tTasks("viewLists"),
  };
  const item = (view: TaskView | "calendar", href: string, text: string) => (
    <li key={view}>
      <Link
        href={href}
        aria-current={current === view ? "page" : undefined}
        className={cx(
          "press-feedback inline-flex min-h-10 items-center rounded-control px-3 text-body font-medium",
          current === view
            ? "bg-accent-subtle font-semibold text-fg shadow-selected"
            : "text-fg-muted hover:bg-accent-subtle hover:text-fg",
        )}
      >
        {text}
      </Link>
    </li>
  );
  return (
    <nav aria-label={t("viewSwitch")} className="mb-4" data-testid="task-view-switch">
      <ul className="flex flex-wrap gap-1">
        {taskViews.map((view) => item(view, viewHref(homeId, view, { list }), label[view]))}
        {item(
          "calendar",
          `${tasksPath(homeId)}/calendar${list ? `?list=${list}` : ""}`,
          t("viewCalendar"),
        )}
      </ul>
    </nav>
  );
}
