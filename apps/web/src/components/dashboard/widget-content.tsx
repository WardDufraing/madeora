import "server-only";

import type { HomePermissionProjection, HomeRole } from "@madeora/domain/permissions";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { ChoreReview } from "@/components/chores/chore-review";
import { ChoreScheduleWidget } from "@/components/chores/chore-schedule-widget";
import {
  LeaderboardWidget,
  MyPointsWidget,
  WeeklyPointsWidget,
} from "@/components/points/points-widgets";
import { PersonalPointsWidget } from "@/components/personal-points/personal-points-widget";
import { RecipesWidget } from "@/components/recipes/recipe-widget";
import {
  HabitInsightsWidget,
  HabitProgressWidget,
  HabitsWidget,
} from "@/components/habits/habit-widgets";
import { MealWidget } from "@/components/meals/meal-widget";
import { ShoppingWidget } from "@/components/shopping/shopping-widget";
import { HomeVacationWidget } from "@/components/vacations/vacation-widget";
import { QuickComplete } from "@/components/chores/quick-complete";
import { messageKeyFor } from "@/components/notifications/notification-list";
import { MemberAvatar } from "@/components/members/member-avatar";
import { CompactTaskList } from "@/components/tasks/compact-task-list";
import { LabelChip } from "@/components/tasks/label-chip";
import {
  advanceChores,
  getChoreContext,
  getChorePool,
  getChoreSettings,
  listChoreSchedule,
} from "@/chores/data";
import { choresPath } from "@/chores/format";
import {
  loadChoreApprovalsWidget,
  loadChoreWidget,
  type ChoreListConfig,
  type ChoreWidgetKind,
} from "@/chores/widget-data";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { DashboardLayout, DashboardWidget } from "@/dashboard/layout";
import type { WidgetEntry } from "@/dashboard/view-types";
import { widgetRegistry, type WidgetConfigs } from "@/dashboard/widgets";
import { formatDateTime, isolate, type DateTimeFormats } from "@/invitations/format";
import { getHomeDirectory } from "@/members/directory";
import { listNotifications } from "@/notifications/server";
import { formatDate, formatWeekday, isoDate, weekdayNames } from "@/preferences/regional";
import type { MyHome } from "@/homes/types";
import { addDays, startOfWeek } from "@/tasks/calendar";
import { listTaskMembers } from "@/tasks/data";
import { taskQueryString } from "@/tasks/filters";
import { formatTaskDate, memberNames, personName, tasksPath } from "@/tasks/format";
import { loadTaskWidget } from "@/tasks/widget-data";

/**
 * The widgets' content (S17), rendered on the server with the viewer's own session for each widget
 * on its own: one widget whose data cannot be read shows an error, and the rest still render. Every
 * Home-sourced widget re-checks the viewer's current membership of its Home (the database does it
 * again for its data), and a widget whose Home the viewer left shows a neutral unavailable state
 * without the Home's name or any of its content.
 */

export interface PersonalScope {
  readonly kind: "personal";
  readonly displayName: string | null;
  readonly formats: DateTimeFormats;
  /** The account timezone is a fallback until this device reports its own. */
  readonly timeZoneIsFallback: boolean;
  /** The viewer's current Homes, for Home-sourced widgets and their labels. */
  readonly homes: readonly MyHome[];
}

export interface HomeScope {
  readonly kind: "home";
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string };
  readonly permissions: HomePermissionProjection;
  readonly formats: DateTimeFormats;
}

export type WidgetScope = PersonalScope | HomeScope;

const linkClass = "text-body font-medium text-accent-fg underline";

function ActionList({ items }: { readonly items: readonly { href: string; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map((item) => (
        <li key={item.href}>
          <Link href={item.href} className={linkClass}>
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

async function WelcomeBody({
  scope,
  config,
}: {
  readonly scope: WidgetScope;
  readonly config: WidgetConfigs["welcome"];
}) {
  const [t, locale] = await Promise.all([getTranslations("Dashboard"), getLocale()]);
  const now = new Date();
  const timeZone = scope.kind === "home" ? scope.home.timeZone : scope.formats.timeZone;
  const heading =
    scope.kind === "home"
      ? t("welcomeHome", { home: isolate(scope.home.name) })
      : scope.displayName
        ? // The name is isolated (FSI … PDI, like <bdi>), so a name written right to left
          // cannot reorder the words around it.
          t("greetingNamed", { name: isolate(scope.displayName) })
        : t("greeting");
  return (
    <div className="flex flex-col gap-1">
      <p className="text-section-title font-semibold text-fg">{heading}</p>
      {config.showDate ? (
        <p className="text-body text-fg-muted">
          <time dateTime={isoDate(now, timeZone)} data-time-zone={timeZone} data-testid="today">
            {t("today", {
              weekday: formatWeekday(now, timeZone, locale),
              date: formatDate(now, timeZone, scope.formats.dateFormat),
            })}
          </time>
          {/* Until this device has reported its timezone, say which one the date is in. */}
          {scope.kind === "personal" && scope.timeZoneIsFallback
            ? ` ${t("todayFallbackZone", { zone: timeZone })}`
            : scope.kind === "home"
              ? ` ${t("todayHomeZone", { zone: timeZone })}`
              : null}
        </p>
      ) : null}
    </div>
  );
}

async function QuickActionsBody({ scope }: { readonly scope: WidgetScope }) {
  const t = await getTranslations("Dashboard");
  if (scope.kind === "home") {
    const base = `/homes/${scope.home.id}`;
    return (
      <ActionList
        items={[
          { href: `${base}/tasks`, label: t("actionTasks") },
          { href: `${base}/members`, label: t("actionMembers") },
          ...(scope.permissions["home.invitations.manage"]
            ? [{ href: `${base}/invitations`, label: t("actionInvite") }]
            : []),
          { href: `${base}/settings`, label: t("actionHomeSettings") },
          { href: `${base}/trash`, label: t("actionHomeTrash") },
        ]}
      />
    );
  }
  return (
    <ActionList
      items={[
        { href: "/tasks", label: t("actionTasks") },
        { href: "/homes/new", label: t("createHome") },
        { href: "/homes/join", label: t("joinHome") },
        { href: "/notifications", label: t("actionNotifications") },
        { href: "/settings", label: t("actionSettings") },
        { href: "/settings/trash", label: t("actionTrash") },
      ]}
    />
  );
}

async function NotificationsBody({
  scope,
  config,
}: {
  readonly scope: PersonalScope;
  readonly config: WidgetConfigs["notifications"];
}) {
  const [t, tNotifications, list] = await Promise.all([
    getTranslations("Dashboard"),
    getTranslations("Notifications"),
    listNotifications(),
  ]);
  if (list.status === "unavailable") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  const items = list.value.slice(0, config.count);
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <EmptyState title={t("notificationsEmptyTitle")} description={t("notificationsEmpty")} />
      ) : (
        <ol className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-0.5">
              <p className="text-body text-fg">
                {item.readAt === null ? (
                  <span className="me-2 font-semibold text-accent-fg">
                    {tNotifications("unread")}.
                  </span>
                ) : null}
                {tNotifications(messageKeyFor(item), {
                  home: item.homeName ? isolate(item.homeName) : tNotifications("homeFallback"),
                  date: item.objectionEndsAt
                    ? formatDateTime(item.objectionEndsAt, scope.formats)
                    : "",
                })}
              </p>
              <p className="text-helper text-fg-muted">
                <time dateTime={item.createdAt}>
                  {formatDateTime(item.createdAt, scope.formats)}
                </time>
              </p>
            </li>
          ))}
        </ol>
      )}
      <p>
        <Link href="/notifications" className={linkClass}>
          {t("notificationsAll")}
        </Link>
      </p>
    </div>
  );
}

async function HomeMembersBody({
  homeId,
  config,
}: {
  readonly homeId: string;
  readonly config: WidgetConfigs["home-members"];
}) {
  const [t, tHomes, locale, directory] = await Promise.all([
    getTranslations("Dashboard"),
    getTranslations("Homes"),
    getLocale(),
    getHomeDirectory(homeId),
  ]);
  if (directory.status !== "ok") {
    // Not a member any more (the database refused) or unreadable: nothing of the Home is shown.
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  const roleKey = {
    owner: "roleOwner",
    administrator: "roleAdministrator",
    member: "roleMember",
  } as const satisfies Record<HomeRole, string>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {directory.members.map((member) => (
          <li key={member.membershipId} className="flex items-center gap-3">
            <MemberAvatar
              name={member.name}
              accentColor={member.accentColor}
              locale={locale}
              avatarFileId={member.avatarFileId ?? null}
            />
            <span className="text-body text-fg">
              {member.name ? isolate(member.name) : t("memberNoName")}
              {member.isSelf ? ` ${t("memberYou")}` : ""}
            </span>
            {config.showRoles ? (
              <span className="ms-auto text-helper text-fg-muted">
                {tHomes(roleKey[member.role])}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p>
        <Link href={`/homes/${homeId}/members`} className={linkClass}>
          {t("membersAll")}
        </Link>
      </p>
    </div>
  );
}

const priorityKey = {
  low: "priorityLow",
  normal: "priorityNormal",
  high: "priorityHigh",
  urgent: "priorityUrgent",
  unset: "priorityUnset",
} as const;
const whenKey = {
  any: "whenAny",
  overdue: "whenOverdue",
  due_today: "whenDueToday",
  due_week: "whenDueWeek",
  upcoming: "whenUpcoming",
  undated: "whenUndated",
} as const;

/**
 * A tasks widget (S19c): one list or All Tasks of its context with its own filters, the tasks'
 * essentials and the completion box where the viewer may complete them. The list and the active
 * filters are always named; a list, label or member that no longer exists is said, never replaced.
 */
async function TasksBody({
  homeId,
  config,
  formats,
}: {
  readonly homeId: string | null;
  readonly config: WidgetConfigs["tasks"];
  readonly formats: DateTimeFormats;
}) {
  const [tWidget, tTasks, data] = await Promise.all([
    getTranslations("TaskWidgets"),
    getTranslations("Tasks"),
    loadTaskWidget(homeId, config),
  ]);
  if (data.status === "unavailable") {
    return <ErrorState title={tWidget("failedTitle")} description={tWidget("failed")} />;
  }
  const base = tasksPath(homeId);
  if (data.status === "list-unavailable") {
    return (
      <EmptyState
        title={tWidget("listUnavailableTitle")}
        description={tWidget("listUnavailable")}
        action={
          <Link href={base} className={linkClass}>
            {tWidget("openTasks")}
          </Link>
        }
      />
    );
  }
  const labelNames = new Map(data.options.labels.map((label) => [label.id, label.name]));
  const memberName = data.options.members.find((member) => member.id === config.memberId)?.name;
  const filters: string[] = [];
  if (config.status !== "open") {
    filters.push(
      config.status === "completed" ? tTasks("statusFilterCompleted") : tTasks("statusFilterAll"),
    );
  }
  if (config.when !== "any") filters.push(tTasks(whenKey[config.when]));
  if (config.priorities.length > 0) {
    filters.push(
      tWidget("filterPriority", {
        priorities: config.priorities.map((value) => tTasks(priorityKey[value])).join(", "),
      }),
    );
  }
  const shownLabels = data.query.label.flatMap((id) => {
    const name = labelNames.get(id);
    return name ? [isolate(name)] : [];
  });
  if (shownLabels.length > 0)
    filters.push(tWidget("filterLabels", { labels: shownLabels.join(", ") }));
  if (homeId && config.assignee !== "any") {
    filters.push(
      config.assignee === "me"
        ? tWidget("filterAssignedToMe")
        : config.assignee === "unassigned"
          ? tWidget("filterUnassigned")
          : tWidget("filterAssignedTo", {
              person: memberName ? isolate(memberName) : tTasks("personFormer"),
            }),
    );
  }
  const { page } = data;
  const allHref = `${base}?${taskQueryString(data.query)}`;
  return (
    <div className="flex flex-col gap-3" data-testid="task-widget">
      <p className="text-helper text-fg-muted" data-testid="task-widget-scope">
        {data.list ? tWidget("scopeList", { list: isolate(data.list.name) }) : tWidget("scopeAll")}
        {filters.length > 0 ? ` · ${filters.join(" · ")}` : ` · ${tWidget("noFilters")}`}
      </p>
      {data.missingLabels > 0 ? (
        <p className="text-helper text-warning">
          {tWidget("labelsMissing", { count: data.missingLabels })}
        </p>
      ) : null}
      {data.missingMember ? (
        <p className="text-helper text-warning">{tWidget("memberMissing")}</p>
      ) : null}
      {page.tasks.length === 0 ? (
        <EmptyState
          title={data.filtered ? tWidget("emptyFilteredTitle") : tWidget("emptyTitle")}
          description={data.filtered ? tWidget("emptyFiltered") : tWidget("empty")}
        />
      ) : (
        <CompactTaskList
          homeId={homeId}
          rows={page.tasks}
          labels={data.options.labels}
          members={data.options.members}
          dateFormat={formats.dateFormat}
          showListName={data.list === null}
          scope={`widget:${homeId ?? "personal"}`}
          loadedAt={new Date().toISOString()}
        />
      )}
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={allHref} className={linkClass}>
          {tWidget("openAll")}
        </Link>
        {page.total > page.tasks.length ? (
          <span className="text-helper text-fg-muted">
            {tWidget("showing", { shown: page.tasks.length, total: page.total })}
          </span>
        ) : null}
      </p>
    </div>
  );
}

const choreStateKey = {
  outstanding: "choreStateOutstanding",
  overdue: "choreStateOverdue",
  pending_approval: "choreStatePending",
  rework: "choreStateRework",
  completed: "choreStateCompleted",
} as const;

/**
 * A My Chores or All Home Chores widget (S20): one Home's occurrences in the chosen state and
 * date range, earliest due first (completed ones newest first), with what is shown always named:
 * the state, the range with its dates in the Home's timezone, and whose. Quick complete where
 * nothing needs a choice (it submits for approval where the chore requires it); anything else opens
 * the occurrence.
 */
async function ChoresBody({
  homeId,
  kind,
  config,
  formats,
}: {
  readonly homeId: string;
  readonly kind: ChoreWidgetKind;
  readonly config: ChoreListConfig;
  readonly formats: DateTimeFormats;
}) {
  const [tChoreWidget, tChores, data] = await Promise.all([
    getTranslations("ChoreWidgets"),
    getTranslations("Chores"),
    loadChoreWidget(homeId, kind, config),
  ]);
  if (data.status === "unavailable") {
    return <ErrorState title={tChoreWidget("failedTitle")} description={tChoreWidget("failed")} />;
  }
  const base = choresPath(homeId);
  const names = memberNames(data.members);
  const who = (memberId: string | null) => {
    if (memberId === null) return tChores("personFormer");
    const name = personName({ me: false, member: memberId }, names);
    return name.kind === "me"
      ? tChores("personYou")
      : name.kind === "member"
        ? isolate(name.name)
        : name.kind === "unnamed"
          ? tChores("personUnnamed")
          : tChores("personFormer");
  };
  const assignee = "assignee" in config ? config.assignee : "any";
  const memberId = "memberId" in config ? config.memberId : null;
  const scope: string[] = [tChoreWidget(choreStateKey[config.state])];
  if (data.from || data.to) {
    const dates = {
      from: data.from ? formatTaskDate(data.from, formats) : "",
      to: data.to ? formatTaskDate(data.to, formats) : "",
    };
    scope.push(
      config.state === "completed"
        ? tChoreWidget("rangeCompleted", dates)
        : data.from === data.to
          ? tChoreWidget("rangeDueOn", dates)
          : tChoreWidget("rangeDue", dates),
    );
  }
  if (kind === "home-chores") {
    scope.push(
      assignee === "unassigned"
        ? tChoreWidget("filterUnassigned")
        : assignee === "member"
          ? tChoreWidget("filterAssignedTo", { person: who(memberId) })
          : tChoreWidget("filterEveryone"),
    );
  }
  const sort =
    config.state === "completed" ? tChoreWidget("sortCompleted") : tChoreWidget("sortDue");
  const selfId = names.selfId;
  return (
    <div className="flex flex-col gap-3" data-testid="chore-widget">
      <p className="text-helper text-fg-muted" data-testid="chore-widget-scope">
        {scope.join(" · ")} · {sort}
      </p>
      {data.missingMember ? (
        <p className="text-helper text-warning">{tChoreWidget("memberMissing")}</p>
      ) : null}
      {data.rows.length === 0 ? (
        <EmptyState title={tChoreWidget("emptyTitle")} description={tChoreWidget("empty")} />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {data.rows.map((row) => {
            const quick =
              row.status === "open" &&
              row.mandatoryOpen === 0 &&
              selfId !== null &&
              (row.assignedToMe || row.assigneeIds.length === 0);
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="chore-widget-row"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`${base}/${row.id}`}
                    className="text-body font-medium text-fg underline-offset-2 hover:underline"
                  >
                    <bdi>{row.title}</bdi>
                  </Link>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
                    {row.category ? (
                      <LabelChip name={row.category.name} color={row.category.color} />
                    ) : null}
                    {row.status === "completed" && row.completedAt ? (
                      <span>
                        {tChores("widgetCompletedBy", {
                          person: row.contributor?.me
                            ? tChores("personYou")
                            : who(row.contributor?.member ?? null),
                          date: formatDateTime(row.completedAt, formats),
                        })}
                      </span>
                    ) : (
                      <span className={row.overdue ? "font-semibold text-danger" : undefined}>
                        {row.overdue
                          ? tChores("overdueSince", { date: formatTaskDate(row.dueDate, formats) })
                          : tChores("dueOn", { date: formatTaskDate(row.dueDate, formats) })}
                      </span>
                    )}
                    {kind === "home-chores" ? (
                      <span>
                        {row.assigneeIds.length === 0
                          ? tChores("unassigned")
                          : row.assigneeIds.map(who).join(", ")}
                      </span>
                    ) : null}
                    {row.status === "pending_approval" ? (
                      <span className="font-semibold text-fg">{tChores("pendingMark")}</span>
                    ) : null}
                    {row.inRework ? (
                      <span className="font-semibold text-fg">{tChores("reworkMark")}</span>
                    ) : null}
                  </p>
                </div>
                {quick && selfId ? (
                  <QuickComplete
                    occurrenceId={row.id}
                    title={row.title}
                    contributor={selfId}
                    requiresApproval={row.requiresApproval}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={base} className={linkClass}>
          {tChoreWidget("openChores")}
        </Link>
        {data.total > data.rows.length ? (
          <span className="text-helper text-fg-muted">
            {tChoreWidget("showing", { shown: data.rows.length, total: data.total })}
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * A Pending Approvals widget (S20): the oldest submissions waiting in the Home's review queue,
 * with approve and reject (each confirmed; rejecting needs a reason), for current chore reviewers
 * only. Anyone else sees that it is for reviewers, without titles or counts.
 */
async function ChoreApprovalsBody({
  homeId,
  count,
  formats,
}: {
  readonly homeId: string;
  readonly count: number;
  readonly formats: DateTimeFormats;
}) {
  const [tChoreWidget, tChores, data] = await Promise.all([
    getTranslations("ChoreWidgets"),
    getTranslations("Chores"),
    loadChoreApprovalsWidget(homeId, count),
  ]);
  if (data.status === "unavailable") {
    return <ErrorState title={tChoreWidget("failedTitle")} description={tChoreWidget("failed")} />;
  }
  if (data.status === "not-reviewer") {
    return (
      <EmptyState
        title={tChoreWidget("notReviewerTitle")}
        description={tChoreWidget("notReviewer")}
      />
    );
  }
  const base = choresPath(homeId);
  const names = memberNames(data.members);
  const who = (person: { readonly me: boolean; readonly member: string | null } | null) => {
    if (person === null) return tChores("personFormer");
    const name = personName(person, names);
    return name.kind === "me"
      ? tChores("personYou")
      : name.kind === "member"
        ? isolate(name.name)
        : name.kind === "unnamed"
          ? tChores("personUnnamed")
          : tChores("personFormer");
  };
  return (
    <div className="flex flex-col gap-3" data-testid="chore-approvals-widget">
      <p className="text-helper text-fg-muted">{tChoreWidget("approvalsScope")}</p>
      {data.approvals.length === 0 ? (
        <EmptyState
          title={tChoreWidget("approvalsEmptyTitle")}
          description={tChoreWidget("approvalsEmpty")}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {data.approvals.map((item) => {
            const reported = formatDateTime(item.submittedAt, formats);
            return (
              <li key={item.submissionId} className="flex flex-col gap-1 py-2">
                <Link
                  href={`${base}/${item.occurrenceId}`}
                  className="text-body font-medium text-fg underline-offset-2 hover:underline"
                >
                  <bdi>{item.title}</bdi>
                </Link>
                <p className="text-helper text-fg-muted">
                  {tChores("pendingRecord", {
                    person: who(item.submittedBy),
                    contributor: who(item.contributor),
                    date: reported,
                  })}
                  {item.late ? ` ${tChores("reportedLate")}` : ""}
                </p>
                <ChoreReview
                  occurrenceId={item.occurrenceId}
                  revision={item.revision}
                  title={item.title}
                  summary={tChores("submissionSummary", {
                    contributor: who(item.contributor),
                    date: reported,
                  })}
                  contributorGone={!item.contributorCurrent}
                  compact
                />
              </li>
            );
          })}
        </ul>
      )}
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={`${base}/approvals`} className={linkClass}>
          {tChoreWidget("openApprovals")}
        </Link>
        {data.total > data.approvals.length ? (
          <span className="text-helper text-fg-muted">
            {tChoreWidget("showing", { shown: data.approvals.length, total: data.total })}
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The Chore schedule widget (S21): the Home's current week, its pool and members, read with the
 * page; other weeks and days are read by the widget itself with the same session.
 */
async function ChoreScheduleBody({
  homeId,
  widgetId,
  config,
  formats,
}: {
  readonly homeId: string;
  readonly widgetId: string;
  readonly config: WidgetConfigs["chore-schedule"];
  readonly formats: DateTimeFormats;
}) {
  const { userId } = await requireIdentity();
  const tChoreWidget = await getTranslations("ChoreWidgets");
  await advanceChores(homeId);
  const [context, settings, members] = await Promise.all([
    getChoreContext(homeId),
    getChoreSettings(homeId),
    listTaskMembers(homeId),
  ]);
  if (context.status !== "ok" || settings.status !== "ok" || members.status !== "ok") {
    return <ErrorState title={tChoreWidget("failedTitle")} description={tChoreWidget("failed")} />;
  }
  const today = context.value.today;
  const weekStart = startOfWeek(today, settings.value.weekStart);
  const [agenda, pool] = await Promise.all([
    listChoreSchedule(homeId, weekStart, addDays(weekStart, 6)),
    getChorePool(homeId, weekStart),
  ]);
  if (agenda.status !== "ok" || pool.status !== "ok") {
    return <ErrorState title={tChoreWidget("failedTitle")} description={tChoreWidget("failed")} />;
  }
  return (
    <ChoreScheduleWidget
      homeId={homeId}
      widgetId={widgetId}
      userId={userId}
      config={config}
      today={today}
      weekStart={weekStart}
      weekdays={weekdayNames(settings.value.weekStart, formats.locale, "short")}
      weekdaysLong={weekdayNames(settings.value.weekStart, formats.locale, "long")}
      members={members.value}
      formats={formats}
      agenda={agenda.value}
      pool={pool.value}
      loadedAt={new Date().toISOString()}
    />
  );
}

// readLayout and checkLayout already parsed every widget's settings with its type's schema; parsing
// again here gives the typed settings, and falls back to the defaults rather than failing.
function welcomeConfig(widget: DashboardWidget): WidgetConfigs["welcome"] {
  const { config } = widgetRegistry.welcome;
  const parsed = config.safeParse(widget.config);
  return parsed.success ? parsed.data : config.parse({});
}
function notificationsConfig(widget: DashboardWidget): WidgetConfigs["notifications"] {
  const { config } = widgetRegistry.notifications;
  const parsed = config.safeParse(widget.config);
  return parsed.success ? parsed.data : config.parse({});
}
function membersConfig(widget: DashboardWidget): WidgetConfigs["home-members"] {
  const { config } = widgetRegistry["home-members"];
  const parsed = config.safeParse(widget.config);
  return parsed.success ? parsed.data : config.parse({});
}
function tasksConfig(widget: DashboardWidget): WidgetConfigs["tasks"] {
  const { config } = widgetRegistry.tasks;
  const parsed = config.safeParse(widget.config);
  return parsed.success ? parsed.data : config.parse({});
}

function recipesConfig(widget: DashboardWidget): WidgetConfigs["recipes"] {
  const { config } = widgetRegistry.recipes;
  const parsed = config.safeParse(widget.config);
  return parsed.success ? parsed.data : config.parse({});
}

function shoppingConfig(widget: DashboardWidget): WidgetConfigs["shopping"] {
  const { config } = widgetRegistry.shopping;
  const parsed = config.safeParse(widget.config);
  return parsed.success ? parsed.data : config.parse({});
}

function mealPlannerConfig(widget: DashboardWidget): WidgetConfigs["meal-planner"] {
  const { config } = widgetRegistry["meal-planner"];
  const parsed = config.safeParse(widget.config);
  return parsed.success ? parsed.data : config.parse({});
}

function habitWidgetConfig<T extends "habits" | "habit-insights" | "habit-progress">(
  type: T,
  widget: DashboardWidget,
): WidgetConfigs[T] {
  const { config } = widgetRegistry[type];
  const parsed = config.safeParse(widget.config);
  return (parsed.success ? parsed.data : config.parse({})) as WidgetConfigs[T];
}

function choreConfig<T extends "my-chores" | "home-chores" | "chore-approvals" | "chore-schedule">(
  type: T,
  widget: DashboardWidget,
): WidgetConfigs[T] {
  const { config } = widgetRegistry[type];
  const parsed = config.safeParse(widget.config);
  return (parsed.success ? parsed.data : config.parse({})) as WidgetConfigs[T];
}

async function entryFor(widget: DashboardWidget, scope: WidgetScope): Promise<WidgetEntry> {
  const t = await getTranslations("Dashboard");
  const titles = {
    welcome: t("widgetWelcome"),
    "quick-actions": t("widgetQuickActions"),
    notifications: t("widgetNotifications"),
    "home-members": t("widgetHomeMembers"),
    tasks: t("widgetTasks"),
    "my-chores": t("widgetMyChores"),
    "home-chores": t("widgetHomeChores"),
    "chore-approvals": t("widgetChoreApprovals"),
    "chore-schedule": t("widgetChoreSchedule"),
    "home-vacation": t("widgetHomeVacation"),
    "weekly-points": t("widgetWeeklyPoints"),
    "points-leaderboard": t("widgetPointsLeaderboard"),
    "my-points": t("widgetMyPoints"),
    "personal-points": t("widgetPersonalPoints"),
    recipes: t("widgetRecipes"),
    shopping: t("widgetShopping"),
    "meal-planner": t("widgetMealPlanner"),
    habits: t("widgetHabits"),
    "habit-insights": t("widgetHabitInsights"),
    "habit-progress": t("widgetHabitProgress"),
  } as const;
  const unavailable: WidgetEntry = {
    id: widget.id,
    title: t("unavailableTitle"),
    sourceName: null,
    body: <EmptyState title={t("unavailableTitle")} description={t("unavailableDescription")} />,
    unavailable: true,
  };

  switch (widget.type) {
    case "welcome":
      return {
        id: widget.id,
        title: titles.welcome,
        sourceName: null,
        body: <WelcomeBody scope={scope} config={welcomeConfig(widget)} />,
        unavailable: false,
      };
    case "quick-actions":
      return {
        id: widget.id,
        title: titles["quick-actions"],
        sourceName: null,
        body: <QuickActionsBody scope={scope} />,
        unavailable: false,
      };
    case "notifications":
      if (scope.kind !== "personal") return unavailable;
      return {
        id: widget.id,
        title: titles.notifications,
        sourceName: null,
        body: <NotificationsBody scope={scope} config={notificationsConfig(widget)} />,
        unavailable: false,
      };
    case "home-members": {
      if (scope.kind === "home") {
        return {
          id: widget.id,
          title: titles["home-members"],
          sourceName: null,
          body: <HomeMembersBody homeId={scope.home.id} config={membersConfig(widget)} />,
          unavailable: false,
        };
      }
      // On the personal dashboard: only for a Home the viewer belongs to now.
      const home = scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (!home) return unavailable;
      return {
        id: widget.id,
        title: t("widgetFromHome", { widget: titles["home-members"], home: isolate(home.name) }),
        sourceName: home.name,
        body: <HomeMembersBody homeId={home.id} config={membersConfig(widget)} />,
        unavailable: false,
      };
    }
    case "tasks": {
      if (scope.kind === "home") {
        return {
          id: widget.id,
          title: t("widgetHomeTasks"),
          sourceName: null,
          body: (
            <TasksBody
              homeId={scope.home.id}
              config={tasksConfig(widget)}
              formats={scope.formats}
            />
          ),
          unavailable: false,
        };
      }
      if (!widget.source) {
        return {
          id: widget.id,
          title: t("widgetPersonalTasks"),
          sourceName: null,
          body: <TasksBody homeId={null} config={tasksConfig(widget)} formats={scope.formats} />,
          unavailable: false,
        };
      }
      // On the personal dashboard bound to a Home: only one the viewer belongs to now.
      const home = scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (!home) return unavailable;
      return {
        id: widget.id,
        title: t("widgetFromHome", { widget: t("widgetHomeTasks"), home: isolate(home.name) }),
        sourceName: home.name,
        body: <TasksBody homeId={home.id} config={tasksConfig(widget)} formats={scope.formats} />,
        unavailable: false,
      };
    }
    case "recipes": {
      if (scope.kind === "home") {
        return {
          id: widget.id,
          title: titles.recipes,
          sourceName: null,
          body: (
            <RecipesWidget
              homeId={scope.home.id}
              widgetId={widget.id}
              config={recipesConfig(widget)}
            />
          ),
          unavailable: false,
        };
      }
      if (!widget.source) {
        return {
          id: widget.id,
          title: t("widgetPersonalRecipes"),
          sourceName: null,
          body: <RecipesWidget homeId={null} widgetId={widget.id} config={recipesConfig(widget)} />,
          unavailable: false,
        };
      }
      // On the personal dashboard bound to a Home: only one the viewer belongs to now.
      const home = scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (!home) return unavailable;
      return {
        id: widget.id,
        title: t("widgetFromHome", { widget: titles.recipes, home: isolate(home.name) }),
        sourceName: home.name,
        body: (
          <RecipesWidget homeId={home.id} widgetId={widget.id} config={recipesConfig(widget)} />
        ),
        unavailable: false,
      };
    }
    case "shopping": {
      if (scope.kind === "home") {
        return {
          id: widget.id,
          title: titles.shopping,
          sourceName: null,
          body: <ShoppingWidget homeId={scope.home.id} config={shoppingConfig(widget)} />,
          unavailable: false,
        };
      }
      if (!widget.source) {
        return {
          id: widget.id,
          title: t("widgetPersonalShopping"),
          sourceName: null,
          body: <ShoppingWidget homeId={null} config={shoppingConfig(widget)} />,
          unavailable: false,
        };
      }
      // On the personal dashboard bound to a Home: only one the viewer belongs to now.
      const home = scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (!home) return unavailable;
      return {
        id: widget.id,
        title: t("widgetFromHome", { widget: titles.shopping, home: isolate(home.name) }),
        sourceName: home.name,
        body: <ShoppingWidget homeId={home.id} config={shoppingConfig(widget)} />,
        unavailable: false,
      };
    }
    case "meal-planner": {
      if (scope.kind === "home") {
        return {
          id: widget.id,
          title: titles["meal-planner"],
          sourceName: null,
          body: <MealWidget home={scope.home} config={mealPlannerConfig(widget)} />,
          unavailable: false,
        };
      }
      if (!widget.source) {
        return {
          id: widget.id,
          title: t("widgetPersonalMealPlanner"),
          sourceName: null,
          body: <MealWidget home={null} config={mealPlannerConfig(widget)} />,
          unavailable: false,
        };
      }
      // On the personal dashboard bound to a Home: only one the viewer belongs to now.
      const home = scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (!home) return unavailable;
      return {
        id: widget.id,
        title: t("widgetFromHome", { widget: titles["meal-planner"], home: isolate(home.name) }),
        sourceName: home.name,
        body: <MealWidget home={home} config={mealPlannerConfig(widget)} />,
        unavailable: false,
      };
    }
    case "habits":
    case "habit-insights":
    case "habit-progress": {
      const type = widget.type;
      const render = (home: { readonly id: string; readonly name: string } | null) =>
        type === "habits" ? (
          <HabitsWidget home={home} config={habitWidgetConfig("habits", widget)} />
        ) : type === "habit-insights" ? (
          <HabitInsightsWidget home={home} config={habitWidgetConfig("habit-insights", widget)} />
        ) : (
          <HabitProgressWidget home={home} config={habitWidgetConfig("habit-progress", widget)} />
        );
      const personalTitle = {
        habits: t("widgetPersonalHabits"),
        "habit-insights": t("widgetPersonalHabitInsights"),
        "habit-progress": t("widgetPersonalHabitProgress"),
      }[type];
      if (scope.kind === "home") {
        return {
          id: widget.id,
          title: titles[type],
          sourceName: null,
          body: render(scope.home),
          unavailable: false,
        };
      }
      if (!widget.source) {
        return {
          id: widget.id,
          title: personalTitle,
          sourceName: null,
          body: render(null),
          unavailable: false,
        };
      }
      // On the personal dashboard bound to a Home: only one the viewer belongs to now.
      const home = scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (!home) return unavailable;
      return {
        id: widget.id,
        title: t("widgetFromHome", { widget: titles[type], home: isolate(home.name) }),
        sourceName: home.name,
        body: render(home),
        unavailable: false,
      };
    }
    case "home-vacation": {
      // Home-only, like chores: the Home's own dashboard, or one the viewer belongs to now.
      const home =
        scope.kind === "home"
          ? null
          : scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (scope.kind !== "home" && !home) return unavailable;
      const homeId = scope.kind === "home" ? scope.home.id : (home?.id ?? "");
      return {
        id: widget.id,
        title: home
          ? t("widgetFromHome", { widget: titles["home-vacation"], home: isolate(home.name) })
          : titles["home-vacation"],
        sourceName: home?.name ?? null,
        body: <HomeVacationWidget homeId={homeId} formats={scope.formats} />,
        unavailable: false,
      };
    }
    case "weekly-points":
    case "points-leaderboard":
    case "my-points": {
      // Home-only, like chores: the Home's own dashboard, or one the viewer belongs to now.
      const home =
        scope.kind === "home"
          ? null
          : scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (scope.kind !== "home" && !home) return unavailable;
      const homeId = scope.kind === "home" ? scope.home.id : (home?.id ?? "");
      let body;
      if (widget.type === "weekly-points") {
        const parsed = widgetRegistry["weekly-points"].config.safeParse(widget.config);
        const view = parsed.success ? parsed.data.view : "mine";
        body = <WeeklyPointsWidget homeId={homeId} view={view} formats={scope.formats} />;
      } else if (widget.type === "points-leaderboard") {
        const parsed = widgetRegistry["points-leaderboard"].config.safeParse(widget.config);
        const config = parsed.success
          ? parsed.data
          : widgetRegistry["points-leaderboard"].config.parse({});
        body = (
          <LeaderboardWidget
            homeId={homeId}
            period={config.period === "default" ? null : config.period}
            count={config.count}
          />
        );
      } else {
        body = <MyPointsWidget homeId={homeId} />;
      }
      return {
        id: widget.id,
        title: home
          ? t("widgetFromHome", { widget: titles[widget.type], home: isolate(home.name) })
          : titles[widget.type],
        sourceName: home?.name ?? null,
        body,
        unavailable: false,
      };
    }
    case "personal-points":
      // S28b: the viewer's own personal ledger, on their personal dashboard only.
      if (scope.kind !== "personal" || widget.source) return unavailable;
      return {
        id: widget.id,
        title: titles["personal-points"],
        sourceName: null,
        body: <PersonalPointsWidget />,
        unavailable: false,
      };
    case "my-chores":
    case "home-chores":
    case "chore-approvals":
    case "chore-schedule": {
      // Chores are Home-only: the Home's own dashboard, or one the viewer belongs to now.
      const home =
        scope.kind === "home"
          ? null
          : scope.homes.find((candidate) => candidate.id === widget.source?.homeId);
      if (scope.kind !== "home" && !home) return unavailable;
      const homeId = scope.kind === "home" ? scope.home.id : (home?.id ?? "");
      const body =
        widget.type === "chore-schedule" ? (
          <ChoreScheduleBody
            homeId={homeId}
            widgetId={widget.id}
            config={choreConfig("chore-schedule", widget)}
            formats={scope.formats}
          />
        ) : widget.type === "chore-approvals" ? (
          <ChoreApprovalsBody
            homeId={homeId}
            count={choreConfig("chore-approvals", widget).count}
            formats={scope.formats}
          />
        ) : (
          <ChoresBody
            homeId={homeId}
            kind={widget.type}
            config={choreConfig(widget.type, widget)}
            formats={scope.formats}
          />
        );
      return {
        id: widget.id,
        title: home
          ? t("widgetFromHome", { widget: titles[widget.type], home: isolate(home.name) })
          : titles[widget.type],
        sourceName: home?.name ?? null,
        body,
        unavailable: false,
      };
    }
  }
}

/** Every widget's title and content, in layout order. */
export async function renderWidgets(
  layout: DashboardLayout,
  scope: WidgetScope,
): Promise<WidgetEntry[]> {
  return Promise.all(layout.widgets.map((widget) => entryFor(widget, scope)));
}
