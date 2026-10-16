import type { ReactNode } from "react";

import type { BuiltInTemplateId } from "./starter";
import type { WidgetType } from "./widgets";

/** One widget as the dashboard shows it: rendered on the server, placed by the client (S17). */
export interface WidgetEntry {
  readonly id: string;
  /** The widget's title, with its source Home for a Home widget on the personal dashboard. */
  readonly title: string;
  /** The source Home's current name (personal dashboard only), shown on every layout. */
  readonly sourceName: string | null;
  readonly body: ReactNode;
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
    }
  | {
      readonly key: string;
      readonly source: "mine" | "shared";
      readonly id: string;
      readonly name: string;
      readonly widgets: readonly WidgetType[];
    };

/** A Home the person may bind a widget to on their personal dashboard. */
export interface SourceHome {
  readonly id: string;
  readonly name: string;
}
