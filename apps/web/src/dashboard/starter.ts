import { LAYOUT_VERSION, type DashboardLayout, type DashboardWidget } from "./layout";
import type { Placement } from "./geometry";
import { defaultConfig, type WidgetType } from "./widgets";

/**
 * The starter layouts (S17; spec "Confirmed editable starter personal dashboard for new adult
 * accounts"). A person or Home without a saved layout sees the current starter; the first save
 * stores a copy, so changing these later never touches a customized dashboard. Module steps add
 * their personal widgets here (the spec's starter set includes a calendar overview and personal
 * tasks, which arrive with S32 and S18). The personal starter never holds a Home widget, and a
 * Household Display never uses either layout.
 *
 * Widget ids are fixed so the starter is the same on every render; they only need to be unique
 * within one layout.
 */

export const STARTER_VERSION = 1;

function widget(id: string, type: WidgetType): DashboardWidget {
  return { id, type, hidden: false, config: defaultConfig(type) };
}

function stacked(items: readonly { readonly id: string; readonly h: number }[]): Placement[] {
  let y = 0;
  return items.map(({ id, h }) => {
    const placement = { id, x: 0, y, w: 1, h };
    y += h;
    return placement;
  });
}

const P_WELCOME = "5d1a0000-0000-4000-8000-000000000001";
const P_ACTIONS = "5d1a0000-0000-4000-8000-000000000002";
const P_NOTIFICATIONS = "5d1a0000-0000-4000-8000-000000000003";

export const personalStarterLayout: DashboardLayout = {
  version: LAYOUT_VERSION,
  widgets: [
    widget(P_WELCOME, "welcome"),
    widget(P_ACTIONS, "quick-actions"),
    widget(P_NOTIFICATIONS, "notifications"),
  ],
  placements: {
    lg: [
      { id: P_WELCOME, x: 0, y: 0, w: 6, h: 2 },
      { id: P_ACTIONS, x: 6, y: 0, w: 6, h: 2 },
      { id: P_NOTIFICATIONS, x: 0, y: 2, w: 6, h: 4 },
    ],
    md: [
      { id: P_WELCOME, x: 0, y: 0, w: 6, h: 2 },
      { id: P_ACTIONS, x: 0, y: 2, w: 6, h: 2 },
      { id: P_NOTIFICATIONS, x: 0, y: 4, w: 6, h: 4 },
    ],
    sm: stacked([
      { id: P_WELCOME, h: 2 },
      { id: P_ACTIONS, h: 3 },
      { id: P_NOTIFICATIONS, h: 4 },
    ]),
  },
};

const H_WELCOME = "5d1a0000-0000-4000-8000-000000000011";
const H_MEMBERS = "5d1a0000-0000-4000-8000-000000000012";
const H_ACTIONS = "5d1a0000-0000-4000-8000-000000000013";

export const homeStarterLayout: DashboardLayout = {
  version: LAYOUT_VERSION,
  widgets: [
    widget(H_WELCOME, "welcome"),
    widget(H_ACTIONS, "quick-actions"),
    widget(H_MEMBERS, "home-members"),
  ],
  placements: {
    lg: [
      { id: H_WELCOME, x: 0, y: 0, w: 6, h: 2 },
      { id: H_ACTIONS, x: 6, y: 0, w: 6, h: 2 },
      { id: H_MEMBERS, x: 0, y: 2, w: 6, h: 4 },
    ],
    md: [
      { id: H_WELCOME, x: 0, y: 0, w: 6, h: 2 },
      { id: H_ACTIONS, x: 0, y: 2, w: 6, h: 2 },
      { id: H_MEMBERS, x: 0, y: 4, w: 6, h: 4 },
    ],
    sm: stacked([
      { id: H_WELCOME, h: 2 },
      { id: H_ACTIONS, h: 3 },
      { id: H_MEMBERS, h: 4 },
    ]),
  },
};

export function starterLayout(dashboard: "personal" | "home"): DashboardLayout {
  return dashboard === "personal" ? personalStarterLayout : homeStarterLayout;
}

/** The built-in templates everyone may apply: the two starters. */
export const builtInTemplates = [
  { id: "starter-personal", kind: "personal", layout: personalStarterLayout },
  { id: "starter-home", kind: "home", layout: homeStarterLayout },
] as const;
export type BuiltInTemplateId = (typeof builtInTemplates)[number]["id"];
