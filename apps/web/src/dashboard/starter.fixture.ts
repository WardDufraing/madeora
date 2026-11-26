import { LAYOUT_VERSION, type DashboardLayout, type DashboardWidget } from "./layout";
import type { Placement } from "./geometry";
import { defaultConfig, type WidgetType } from "./widgets";

/**
 * The personal starter as it was before the page heading took over the greeting (it held a Welcome
 * widget). Tests that need a layout with several widget types, including Welcome, use this
 * fixture; the shipped starter is in `starter.ts`.
 */

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
const P_TASKS = "5d1a0000-0000-4000-8000-000000000004";
const P_EVENTS = "5d1a0000-0000-4000-8000-000000000005";

export const legacyPersonalStarterLayout: DashboardLayout = {
  version: LAYOUT_VERSION,
  widgets: [
    widget(P_WELCOME, "welcome"),
    widget(P_ACTIONS, "quick-actions"),
    widget(P_NOTIFICATIONS, "notifications"),
    widget(P_TASKS, "tasks"),
    widget(P_EVENTS, "upcoming-events"),
  ],
  placements: {
    lg: [
      { id: P_WELCOME, x: 0, y: 0, w: 6, h: 2 },
      { id: P_ACTIONS, x: 6, y: 0, w: 6, h: 2 },
      { id: P_NOTIFICATIONS, x: 0, y: 2, w: 6, h: 4 },
      { id: P_TASKS, x: 6, y: 2, w: 6, h: 4 },
      { id: P_EVENTS, x: 6, y: 6, w: 6, h: 4 },
    ],
    md: [
      { id: P_WELCOME, x: 0, y: 0, w: 6, h: 2 },
      { id: P_ACTIONS, x: 0, y: 2, w: 6, h: 2 },
      { id: P_NOTIFICATIONS, x: 0, y: 4, w: 6, h: 4 },
      { id: P_TASKS, x: 0, y: 8, w: 6, h: 4 },
      { id: P_EVENTS, x: 0, y: 12, w: 6, h: 4 },
    ],
    sm: stacked([
      { id: P_WELCOME, h: 2 },
      { id: P_ACTIONS, h: 3 },
      { id: P_NOTIFICATIONS, h: 4 },
      { id: P_TASKS, h: 5 },
      { id: P_EVENTS, h: 4 },
    ]),
  },
};
