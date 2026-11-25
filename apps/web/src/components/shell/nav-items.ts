import {
  CalendarIcon,
  ChoresIcon,
  DashboardIcon,
  GoalsIcon,
  HabitsIcon,
  HelpIcon,
  IntegrationsIcon,
  MealsIcon,
  PetsIcon,
  PhotosIcon,
  SettingsIcon,
  ShoppingIcon,
  TasksIcon,
  type IconComponent,
} from "@madeora/icons";

export type NavId =
  | "dashboard"
  | "calendar"
  | "tasks"
  | "chores"
  | "meals"
  | "shopping"
  | "habits"
  | "goals"
  | "pets"
  | "photos"
  | "integrations"
  | "settings"
  | "help";

export interface NavItem {
  /** Also the message key in the `Nav` dictionary. */
  readonly id: NavId;
  readonly href: string;
  readonly icon: IconComponent;
}

/**
 * The sidebar's everyday destinations, after the reference mockup with "Memories" renamed Photos
 * (docs/design/design-decisions.md). Trash is reached from settings, not the sidebar (spec).
 */
export const primaryNav: readonly NavItem[] = [
  { id: "dashboard", href: "/", icon: DashboardIcon },
  { id: "calendar", href: "/calendar", icon: CalendarIcon },
  { id: "tasks", href: "/tasks", icon: TasksIcon },
  { id: "chores", href: "/chores", icon: ChoresIcon },
  // S27: Meals opens the meal planner; Recipes (S24) belongs to the same section.
  { id: "meals", href: "/meals", icon: MealsIcon },
  { id: "shopping", href: "/shopping", icon: ShoppingIcon },
  { id: "habits", href: "/habits", icon: HabitsIcon },
  { id: "goals", href: "/goals", icon: GoalsIcon },
  { id: "pets", href: "/pets", icon: PetsIcon },
  { id: "photos", href: "/photos", icon: PhotosIcon },
  { id: "integrations", href: "/integrations", icon: IntegrationsIcon },
];

/** Secondary and help controls at the bottom of the sidebar (spec). */
export const secondaryNav: readonly NavItem[] = [
  { id: "settings", href: "/settings", icon: SettingsIcon },
  { id: "help", href: "/help", icon: HelpIcon },
];

/**
 * Sections that exist in the navigation but are not built yet. They render a "not built yet"
 * page; each module's step removes its id here when it adds the real page.
 */
export const unbuiltSections: ReadonlySet<NavId> = new Set(["integrations", "help"]);

/** Whether a URL segment names an unbuilt navigation section. */
export function isUnbuiltSection(value: string): value is NavId {
  return (unbuiltSections as ReadonlySet<string>).has(value);
}

const homePath =
  /^\/homes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** The Home whose pages are open (`/homes/{id}/...`), or `null` in the Personal context. */
export function homeIdFromPath(pathname: string): string | null {
  return homePath.exec(pathname)?.[1]?.toLowerCase() ?? null;
}

/**
 * Where an item leads in the current context: Dashboard opens the Home's dashboard while a Home is
 * open (S09), the personal dashboard otherwise; Tasks opens the Home's tasks (S18), Chores the Home's
 * chores (S20). Other sections
 * are not Home-aware yet; each module's step decides when it adds its pages. Meals opens the
 * Home's meal planner (S27), Shopping the Home's shopping lists (S26), Habits the Home's habits
 * (S28), Goals the Home's goals (S30), Pets the Home's pets (S31), Calendar the Home's calendar
 * (S32).
 */
export function contextHref(item: NavItem, homeId: string | null): string {
  if (
    item.id === "calendar" ||
    item.id === "tasks" ||
    item.id === "chores" ||
    item.id === "shopping" ||
    item.id === "meals" ||
    item.id === "habits" ||
    item.id === "goals" ||
    item.id === "pets" ||
    item.id === "photos"
  ) {
    return homeId !== null ? `/homes/${homeId}/${item.id}` : item.href;
  }
  if (item.id !== "dashboard") return item.href;
  // In Personal, Dashboard says so, so a Home remembered from earlier cannot pull the person back.
  return homeId !== null ? `/homes/${homeId}` : "/?context=personal";
}

/** Whether a navigation item is current: its page, or a page of its section (Meals: also Recipes). */
export function isItemActive(item: NavItem, homeId: string | null, pathname: string): boolean {
  if (isActive(contextHref(item, homeId), pathname)) return true;
  return (
    item.id === "meals" &&
    isActive(homeId !== null ? `/homes/${homeId}/recipes` : "/recipes", pathname)
  );
}

/** Whether `href` is the current page or a page inside it. */
export function isActive(target: string, pathname: string): boolean {
  const href = target.split("?")[0] ?? target;
  if (href === "/") return pathname === "/";
  // A Home's dashboard is current only on itself; its settings page belongs to no nav item yet.
  // A Home's section (its tasks) is current on itself and its pages.
  const homeId = homeIdFromPath(href);
  if (homeId !== null) {
    const path = pathname.toLowerCase();
    const target = href.toLowerCase();
    if (target === `/homes/${homeId}`) return path === target;
    return path === target || path.startsWith(`${target}/`);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The destinations that stay prominent everywhere (redesign decision 10). Never pinned or unpinned. */
export const coreNavIds: readonly NavId[] = ["dashboard", "calendar", "tasks"];

/** The modules a person can pin as shortcuts, or find in All modules: everything but core and secondary. */
export const moduleNav: readonly NavItem[] = primaryNav.filter(
  (item) => !coreNavIds.includes(item.id),
);

/** The core destinations, in order. */
export const coreNav: readonly NavItem[] = primaryNav.filter((item) =>
  coreNavIds.includes(item.id),
);

const pinnableIds: ReadonlySet<string> = new Set(moduleNav.map((item) => item.id));

/**
 * The shortcuts shown until the person pins their own: what a household does daily in a Home,
 * what a person tracks on their own in Personal. Pinning anything replaces them (decision 10).
 */
export function defaultFavorites(homeId: string | null): readonly NavId[] {
  return homeId !== null ? ["chores", "meals", "shopping"] : ["shopping", "habits", "goals"];
}

/**
 * The shortcuts in effect: the person's pinned list (cleaned of anything that cannot be pinned),
 * or the context's defaults when they never chose.
 */
export function resolveFavorites(saved: readonly string[] | null, homeId: string | null): NavId[] {
  if (saved === null) return [...defaultFavorites(homeId)];
  const clean = saved.filter((id): id is NavId => pinnableIds.has(id));
  return [...new Set(clean)];
}

/** Where All modules lives in the current context. */
export function modulesHref(homeId: string | null): string {
  return homeId !== null ? `/homes/${homeId}/modules` : "/modules";
}

/** Where the quick-create entries lead until each module has its own creation dialog (UX3, UX4, UX6). */
export function createHref(kind: "task" | "event" | "shopping", homeId: string | null): string {
  const base = homeId !== null ? `/homes/${homeId}` : "";
  if (kind === "event") return `${base}/calendar/new`;
  return `${base}/${kind === "task" ? "tasks" : "shopping"}`;
}
