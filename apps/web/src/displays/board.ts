import "server-only";

import { z } from "zod";

import { isShoppingUnit, type ShoppingUnit } from "@madeora/domain/shopping";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import {
  readDisplayLayout,
  type DisplayLayout,
  type DisplayPreferences,
  displayClockFormats,
  displayDensities,
  displayOrientations,
  displayThemes,
} from "./layout";

/**
 * What a paired display shows (S44), read with the display's own session through
 * `public.display_board`, which alone decides what is shared-display-safe. While locked the
 * database returns the lock screen's fields only, so nothing else can reach the browser.
 */

const preferencesShape = {
  display_id: z.uuid(),
  timezone: z.string(),
  theme: z.enum(displayThemes),
  clock_format: z.enum(displayClockFormats),
  density: z.enum(displayDensities),
  orientation: z.enum(displayOrientations),
  signal_version: z.number().int(),
};

const memberSchema = z.object({
  membership_id: z.uuid(),
  name: z.string().nullable(),
  accent_color: z.string().nullable(),
  is_child: z.boolean(),
  has_pin: z.boolean(),
  requires_pin: z.boolean(),
});

const boardSchema = z.discriminatedUnion("locked", [
  z.object({ locked: z.literal(true), lock_message: z.string().nullable(), ...preferencesShape }),
  z.object({
    locked: z.literal(false),
    ...preferencesShape,
    display_name: z.string(),
    home_name: z.string(),
    layout: z.unknown(),
    actions: z.boolean(),
    require_pin: z.boolean(),
    members: z.array(memberSchema),
    lock_managers: z.array(
      z.object({
        membership_id: z.uuid(),
        name: z.string().nullable(),
        accent_color: z.string().nullable(),
      }),
    ),
    chores: z.array(
      z.object({
        occurrence_id: z.uuid(),
        title: z.string(),
        due_date: z.string(),
        overdue: z.boolean(),
        assignee_ids: z.array(z.uuid()),
        mandatory_open: z.number().int(),
        requires_approval: z.boolean(),
        requires_pin: z.boolean(),
      }),
    ),
    shopping: z.array(
      z.object({
        list_id: z.uuid(),
        name: z.string(),
        remaining: z.number().int(),
        items: z.array(
          z.object({
            item_id: z.uuid(),
            name: z.string(),
            quantity: z.string().nullable(),
            unit: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
]);

export interface DisplayBoardMember {
  readonly membershipId: string;
  readonly name: string | null;
  readonly accentColor: string | null;
  readonly isChild: boolean;
  readonly hasPin: boolean;
  readonly requiresPin: boolean;
}

export interface DisplayBoardChore {
  readonly occurrenceId: string;
  readonly title: string;
  readonly dueDate: string;
  readonly overdue: boolean;
  readonly assigneeIds: readonly string[];
  readonly mandatoryOpen: number;
  readonly requiresApproval: boolean;
  readonly requiresPin: boolean;
}

export interface DisplayBoardList {
  readonly listId: string;
  readonly name: string;
  readonly remaining: number;
  readonly items: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly quantity: string | null;
    readonly unit: ShoppingUnit | null;
  }[];
}

interface BoardBase {
  /** The display's own id (for its Realtime signal). */
  readonly displayId: string;
  readonly timeZone: string;
  readonly preferences: DisplayPreferences;
  /** The display's signal version when this was read (Realtime tells it when to read again). */
  readonly signalVersion: number;
}

export type DisplayBoard =
  | (BoardBase & { readonly locked: true; readonly lockMessage: string | null })
  | (BoardBase & {
      readonly locked: false;
      readonly displayName: string;
      readonly homeName: string;
      readonly layout: DisplayLayout;
      readonly actions: boolean;
      readonly requirePin: boolean;
      readonly members: readonly DisplayBoardMember[];
      readonly lockManagers: readonly {
        readonly membershipId: string;
        readonly name: string | null;
        readonly accentColor: string | null;
      }[];
      readonly chores: readonly DisplayBoardChore[];
      readonly shopping: readonly DisplayBoardList[];
    });

/**
 * `ok` with the board, `refused` when the database no longer accepts this display (revoked, Home
 * closed, session not registered), `unavailable` when it cannot be asked now.
 */
export type DisplayBoardResult =
  | { readonly kind: "ok"; readonly board: DisplayBoard }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

const REFUSED_CODES = new Set(["42501", "PT401", "PT403", "PGRST301", "PGRST303"]);

function log(event: string, code?: string): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/** Maps the database's answer (exported for tests). */
export function toDisplayBoard(data: unknown): DisplayBoard | null {
  const parsed = boardSchema.safeParse(data);
  if (!parsed.success) return null;
  const row = parsed.data;
  const base: BoardBase = {
    displayId: row.display_id,
    timeZone: row.timezone,
    preferences: {
      orientation: row.orientation,
      theme: row.theme,
      density: row.density,
      clockFormat: row.clock_format,
    },
    signalVersion: row.signal_version,
  };
  if (row.locked) return { ...base, locked: true, lockMessage: row.lock_message };
  return {
    ...base,
    locked: false,
    displayName: row.display_name,
    homeName: row.home_name,
    layout: readDisplayLayout(row.layout),
    actions: row.actions,
    requirePin: row.require_pin,
    members: row.members.map((m) => ({
      membershipId: m.membership_id,
      name: m.name,
      accentColor: m.accent_color,
      isChild: m.is_child,
      hasPin: m.has_pin,
      requiresPin: m.requires_pin,
    })),
    lockManagers: row.lock_managers.map((m) => ({
      membershipId: m.membership_id,
      name: m.name,
      accentColor: m.accent_color,
    })),
    chores: row.chores.map((c) => ({
      occurrenceId: c.occurrence_id,
      title: c.title,
      dueDate: c.due_date,
      overdue: c.overdue,
      assigneeIds: c.assignee_ids,
      mandatoryOpen: c.mandatory_open,
      requiresApproval: c.requires_approval,
      requiresPin: c.requires_pin,
    })),
    shopping: row.shopping.map((list) => ({
      listId: list.list_id,
      name: list.name,
      remaining: list.remaining,
      items: list.items.map((item) => ({
        itemId: item.item_id,
        name: item.name,
        quantity: item.quantity,
        unit: isShoppingUnit(item.unit) ? item.unit : null,
      })),
    })),
  };
}

/** This display's board, read with its own session. */
export async function getDisplayBoard(): Promise<DisplayBoardResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error, status } = await supabase.rpc("display_board");
  if (error) {
    if (status === 401 || status === 403 || REFUSED_CODES.has(error.code)) {
      return { kind: "refused" };
    }
    log("display_board.read_failed", error.code);
    return { kind: "unavailable" };
  }
  const board = toDisplayBoard(data);
  if (!board) {
    log("display_board.shape");
    return { kind: "unavailable" };
  }
  return { kind: "ok", board };
}
