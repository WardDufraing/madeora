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
  { id: "meals", href: "/meals", icon: MealsIcon },
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
  "tasks",
  "chores",
  "meals",
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

/** Whether `href` is the current page or a page inside it. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
