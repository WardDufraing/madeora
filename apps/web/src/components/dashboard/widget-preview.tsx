import type { WidgetType } from "@/dashboard/widgets";

/** The rough layout a widget shows, for the picker's small preview (review item S17-L9). */
type PreviewShape = "text" | "buttons" | "list" | "people" | "progress" | "calendar" | "tiles";

export const widgetPreviewShape = {
  welcome: "text",
  "quick-actions": "buttons",
  notifications: "list",
  "home-members": "people",
  tasks: "list",
  "my-chores": "list",
  "home-chores": "list",
  "chore-approvals": "list",
  "chore-schedule": "calendar",
  "home-vacation": "calendar",
  "weekly-points": "progress",
  "points-leaderboard": "people",
  "my-points": "progress",
  "personal-points": "progress",
  recipes: "tiles",
  shopping: "list",
  "meal-planner": "calendar",
  habits: "list",
  "habit-insights": "progress",
  "habit-progress": "progress",
  goals: "list",
  "goal-progress": "progress",
  "pet-care": "list",
  "upcoming-events": "calendar",
  photos: "tiles",
  ora: "buttons",
} as const satisfies Record<WidgetType, PreviewShape>;

const bar = "rounded-full bg-line";

function Shape({ shape }: { readonly shape: PreviewShape }) {
  switch (shape) {
    case "text":
      return (
        <div className="flex flex-col gap-1">
          <span className="h-1.5 w-3/4 rounded-full bg-accent" />
          <span className={`${bar} h-1 w-full`} />
          <span className={`${bar} h-1 w-2/3`} />
        </div>
      );
    case "buttons":
      return (
        <div className="grid grid-cols-2 gap-1">
          {[0, 1, 2, 3].map((key) => (
            <span key={key} className="h-2.5 rounded-sm bg-accent-subtle" />
          ))}
        </div>
      );
    case "list":
      return (
        <div className="flex flex-col gap-1">
          {[0, 1, 2].map((key) => (
            <span key={key} className="flex items-center gap-1">
              <span className="size-1.5 shrink-0 rounded-sm border border-line-control" />
              <span className={`${bar} h-1 flex-1`} />
            </span>
          ))}
        </div>
      );
    case "people":
      return (
        <div className="flex flex-col gap-1">
          {[0, 1, 2].map((key) => (
            <span key={key} className="flex items-center gap-1">
              <span className="size-2 shrink-0 rounded-full bg-accent-subtle" />
              <span className={`${bar} h-1 flex-1`} />
            </span>
          ))}
        </div>
      );
    case "progress":
      return (
        <div className="flex flex-col gap-1.5">
          {["w-3/4", "w-1/2"].map((width) => (
            <span key={width} className={`${bar} h-1.5 w-full`}>
              <span className={`block h-full rounded-full bg-accent ${width}`} />
            </span>
          ))}
        </div>
      );
    case "calendar":
      return (
        <div className="grid grid-cols-4 gap-0.5">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((key) => (
            <span key={key} className={`h-1.5 rounded-sm ${key === 5 ? "bg-accent" : "bg-line"}`} />
          ))}
        </div>
      );
    case "tiles":
      return (
        <div className="grid grid-cols-3 gap-0.5">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <span key={key} className="h-2.5 rounded-sm bg-accent-subtle" />
          ))}
        </div>
      );
  }
}

/**
 * A small schematic of what a widget looks like, beside its name in the dashboard's widget picker.
 * Decorative only: the name and description carry the meaning, so it is hidden from assistive
 * technology.
 */
export function WidgetPreview({ type }: { readonly type: WidgetType }) {
  return (
    <div
      aria-hidden="true"
      data-testid={`widget-preview-${type}`}
      data-shape={widgetPreviewShape[type]}
      className="w-16 shrink-0 rounded-control border border-line bg-surface-sunken p-1.5"
    >
      <Shape shape={widgetPreviewShape[type]} />
    </div>
  );
}
