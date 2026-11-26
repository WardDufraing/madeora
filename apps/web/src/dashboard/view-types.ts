import type { ReactNode } from "react";

import type { LayoutPreview } from "./preview";
import type { BuiltInTemplateId } from "./starter";
import type { EmptyStateMode, WidgetType } from "./widgets";

/** One widget as the dashboard shows it: rendered on the server, placed by the client (S17). */
export interface WidgetEntry {
  readonly id: string;
  /** The widget's title, with its source Home for a Home widget on the personal dashboard. */
  readonly title: string;
  /** The source Home's current name (personal dashboard only), shown on every layout. */
  readonly sourceName: string | null;
  readonly body: ReactNode;
  readonly type: WidgetType;
  /** The full module view for this widget's context (UX2a menu: "Open"), or null when none fits. */
  readonly href: string | null;
  /** What the widget does when empty; `hide` only ever hides it while it is rendered. */
  readonly emptyState: EmptyStateMode;
  /** Its Home is no longer one the viewer belongs to. */
  readonly unavailable: boolean;
}

/** A template the editor offers to apply. */
export type TemplateOption =
  | {
      readonly key: string;
      readonly source: "built-in";
      readonly builtIn: BuiltInTemplateId;
      readonly widgets: readonly WidgetType[];
      /** Its arrangement, for the preview before applying it (UX2c). */
      readonly preview: LayoutPreview;
    }
  | {
      readonly key: string;
      readonly source: "mine" | "shared";
      readonly id: string;
      readonly name: string;
      readonly widgets: readonly WidgetType[];
      /** Its arrangement, for the preview before applying it (UX2c); null if the server sent none. */
      readonly preview: LayoutPreview | null;
    };

/** A Home the person may bind a widget to on their personal dashboard. */
export interface SourceHome {
  readonly id: string;
  readonly name: string;
}
