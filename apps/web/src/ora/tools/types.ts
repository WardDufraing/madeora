import type { HomeAction, HomeMembershipFacts } from "@madeora/domain/permissions";

import type { ActionPreview, UndoResult } from "../actions/types";
import type { Overview, OverviewShare } from "../overview/types";
import type { OraToolId } from "./ids";

/**
 * The typed server-side tools layer Ora uses (S45, spec "Ora capabilities": Ora can only do what
 * the person may do). A tool is a named, validated, permission-checked operation. Ora never reads
 * or changes anything except through a tool, and listing and running a tool both ask the
 * permission engine, so what the panel offers is never wider than what the person may do and a
 * forged request for a tool they may not use is refused.
 *
 * Kinds: `navigate` opens a Madeora page (no data is read or changed), `read` returns data the
 * person may already see. `action` (S47) is a guided change: the tool prepares an editable preview
 * and can undo, while the change itself is made, after the person confirms, through the module's
 * own authorized API, so Ora never writes anything the module would refuse.
 */

export type OraToolKind = "navigate" | "read" | "action";

/** The modules a tool belongs to, for grouping in "Browse all actions". */
export type OraToolGroup =
  | "overview"
  | "tasks"
  | "chores"
  | "meals"
  | "shopping"
  | "habits"
  | "goals"
  | "pets"
  | "calendar"
  | "photos"
  | "home"
  | "ora";

/** Where a tool is available and what the person must be allowed to do there. */
export type OraRequirement =
  /** Personal space only; it needs nothing beyond being signed in. */
  | { readonly scope: "personal" }
  /** One Home only, and the person's membership there must allow `action`. */
  | { readonly scope: "home"; readonly action: HomeAction }
  /** Anywhere (Personal or any Home); it needs nothing beyond being signed in. */
  | { readonly scope: "any" };

/** The person and place a tool call runs for, resolved server-side from the database. */
export interface OraToolContext {
  /** `null`: Personal space. */
  readonly home: { readonly id: string; readonly membership: HomeMembershipFacts } | null;
}

export interface OraToolSummary {
  /** Stable id; also the message key for its label in the `Ora.tools` dictionary. */
  readonly id: OraToolId;
  readonly kind: OraToolKind;
  readonly group: OraToolGroup;
  /** Offered as a button when Ora opens, rather than only under "Browse all actions". */
  readonly quick: boolean;
}

export type OraToolOutput =
  | { readonly kind: "navigate"; readonly href: string }
  | { readonly kind: "capabilities"; readonly tools: readonly OraToolSummary[] }
  | { readonly kind: "overview"; readonly overview: Overview }
  | { readonly kind: "share"; readonly share: OverviewShare }
  | { readonly kind: "action-preview"; readonly preview: ActionPreview }
  | { readonly kind: "action-undo"; readonly result: UndoResult };

export interface OraToolDefinition extends OraToolSummary {
  readonly requires: OraRequirement;
  readonly run: (context: OraToolContext) => OraToolOutput;
}

/**
 * A read tool that takes input (S46): it is listed and permission-checked like every other tool, but
 * runs through the server-only executor (`run-input.ts`), which validates the input first.
 */
export interface OraInputToolDefinition extends OraToolSummary {
  readonly requires: OraRequirement;
}

export type OraToolResult =
  | { readonly status: "ok"; readonly output: OraToolOutput }
  /** Unknown tool, wrong place, or not allowed: deliberately indistinguishable to the caller. */
  | { readonly status: "forbidden" }
  /** Allowed, but the input did not fit the tool's schema. */
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

export type OraToolsErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "unavailable";

/** `GET /api/v1/ora/tools` */
export interface OraToolsResponse {
  readonly tools: readonly OraToolSummary[];
}

/** `POST /api/v1/ora/tools` */
export interface OraToolRunResponse {
  readonly output: OraToolOutput;
}
