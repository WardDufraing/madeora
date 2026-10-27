import {
  CalendarIcon,
  ChoresIcon,
  DashboardIcon,
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
  // S24: Meals opens Recipes until the meal planner (S27) adds its own page to the section.
  { id: "meals", href: "/recipes", icon: MealsIcon },
  { id: "shopping", href: "/shopping", icon: ShoppingIcon },
  { id: "habits", href: "/habits", icon: HabitsIcon },
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
export const unbuiltSections: ReadonlySet<NavId> = new Set([
  "calendar",
  "shopping",
  "habits",
  "pets",
  "photos",
  "integrations",
  "help",
]);

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
 * Home's recipes (S24).
 */
export function contextHref(item: NavItem, homeId: string | null): string {
  if (item.id === "tasks" || item.id === "chores") {
    return homeId !== null ? `/homes/${homeId}/${item.id}` : item.href;
  }
  if (item.id === "meals") return homeId !== null ? `/homes/${homeId}/recipes` : item.href;
  if (item.id !== "dashboard") return item.href;
  // In Personal, Dashboard says so, so a Home remembered from earlier cannot pull the person back.
  return homeId !== null ? `/homes/${homeId}` : "/?context=personal";
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
