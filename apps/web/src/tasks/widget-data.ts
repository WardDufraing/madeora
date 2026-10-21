import "server-only";

import type { WidgetConfigs } from "@/dashboard/widgets";

import type { TaskPage } from "./api";
import { advanceSeries, listTaskLabels, listTaskLists, listTaskMembers, listTasks } from "./data";
import type { MemberOption } from "./format";
import { defaultTaskQuery } from "./filters";
import type { LabelColor, TaskQuery } from "./schema";

/**
 * What a tasks widget shows (S19c), read with the viewer's own session like the full Tasks page. The
 * widget's saved settings name lists, labels and members by id; each is checked against the context
 * now, and one that no longer exists is reported rather than replaced: a missing list makes the
 * widget say so (never another list), a missing label or member is left out of the filter and
 * named in a note, and a missing member matches nobody.
 */

export type TaskWidgetConfig = WidgetConfigs["tasks"];

export interface TaskWidgetOptions {
  readonly lists: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
  }[];
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: LabelColor | null;
  }[];
  readonly members: readonly MemberOption[];
}

export type TaskWidgetData =
  | {
      readonly status: "ok";
      readonly page: TaskPage;
      /** The list shown, or null for All Tasks. */
      readonly list: { readonly id: string; readonly name: string } | null;
      readonly options: TaskWidgetOptions;
      /** The query the widget ran, for "Open all" with the same filters. */
      readonly query: TaskQuery;
      readonly missingLabels: number;
      readonly missingMember: boolean;
      /** Any filter besides the list differs from the defaults. */
      readonly filtered: boolean;
    }
  /** The chosen list was deleted or archived. */
  | { readonly status: "list-unavailable"; readonly options: TaskWidgetOptions }
  | { readonly status: "unavailable" };

/** The lists, labels and members of a context, for the widget and its settings. */
export async function loadTaskOptions(
  homeId: string | null,
): Promise<
  | { readonly status: "ok"; readonly options: TaskWidgetOptions }
  | { readonly status: "not-found" | "unavailable" }
> {
  const [lists, labels, members] = await Promise.all([
    listTaskLists(homeId, true),
    listTaskLabels(homeId),
    homeId ? listTaskMembers(homeId) : Promise.resolve({ status: "ok", value: [] } as const),
  ]);
  if (lists.status !== "ok" || labels.status !== "ok" || members.status !== "ok") {
    const notFound = [lists, labels, members].some((read) => read.status === "not-found");
    return { status: notFound ? "not-found" : "unavailable" };
  }
  return {
    status: "ok",
    options: {
      lists: lists.value.map(({ id, name, archived }) => ({ id, name, archived })),
      labels: labels.value.map(({ id, name, color }) => ({ id, name, color })),
      members: members.value,
    },
  };
}

export async function loadTaskWidget(
  homeId: string | null,
  config: TaskWidgetConfig,
): Promise<TaskWidgetData> {
  // Recurring series create their due occurrences before anything is read (S19).
  await advanceSeries(homeId);
  const loaded = await loadTaskOptions(homeId);
  if (loaded.status !== "ok") return { status: "unavailable" };
  const { options } = loaded;

  let list: { readonly id: string; readonly name: string } | null = null;
  if (config.listId) {
    const found = options.lists.find((candidate) => candidate.id === config.listId);
    if (!found || found.archived) return { status: "list-unavailable", options };
    list = { id: found.id, name: found.name };
  }
  const knownLabels = new Set(options.labels.map((label) => label.id));
  const labelIds = config.labelIds.filter((id) => knownLabels.has(id));
  const isHome = homeId !== null;
  const memberKnown =
    config.memberId !== null && options.members.some((member) => member.id === config.memberId);
  const assignee = isHome ? config.assignee : "any";
  const missingMember = isHome && assignee === "member" && !memberKnown;

  const query: TaskQuery = {
    ...defaultTaskQuery,
    list: list?.id,
    status: config.status,
    when: config.when,
    priority: [...config.priorities],
    label: labelIds,
    ...(assignee === "member"
      ? config.memberId
        ? { assignee: "member", member: config.memberId }
        : { assignee: "any" }
      : { assignee }),
  };
  const page = await listTasks(homeId, query, config.count);
  if (page.status !== "ok") return { status: "unavailable" };
  return {
    status: "ok",
    page: page.value,
    list,
    options,
    query,
    missingLabels: config.labelIds.length - labelIds.length,
    missingMember,
    filtered:
      config.status !== "open" ||
      config.when !== "any" ||
      config.priorities.length > 0 ||
      config.labelIds.length > 0 ||
      assignee !== "any",
  };
}
