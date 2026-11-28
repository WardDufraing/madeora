"use client";

import { DragHandleIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Responsive,
  useContainerWidth,
  verticalCompactor,
  type Compactor,
  type Layout,
  type LayoutItem,
} from "react-grid-layout";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import {
  canMove,
  canResize,
  emptySlots,
  fitsRows,
  keepsGaps,
  moveInStack,
  moveWidget,
  reflow,
  resizeWidget,
  setSize,
  sizePresets,
  type MoveDirection,
  type Placement,
  type ResizeDirection,
  type SizePresetId,
  type Slot,
} from "@/dashboard/geometry";
import {
  addWidget,
  canAddWidget,
  MAX_ROWS,
  removeWidget,
  type DashboardLayout,
  type DashboardWidget,
} from "@/dashboard/layout";
import type { DashboardTarget } from "@/dashboard/schema";
import { layoutPreview } from "@/dashboard/preview";
import { starterLayout } from "@/dashboard/starter";
import type { SourceHome, TemplateOption, WidgetEntry } from "@/dashboard/view-types";
import {
  breakpointColumns,
  breakpointFor,
  breakpointMinWidths,
  breakpoints,
  defaultConfig,
  emptyStateModeOf,
  GRID_GAP,
  ROW_HEIGHT,
  widgetRegistry,
  type Breakpoint,
  type WidgetType,
} from "@/dashboard/widgets";
import { isolate } from "@/invitations/format";

import { WidgetFrame } from "./dashboard-grid";
import { LayoutPreviewView } from "./layout-preview";
import { LayoutTools } from "./layout-tools";
import { presetKey, StackEditor } from "./stack-editor";
import { useDraftAutosave, type DraftStatus } from "./use-draft-autosave";
import { useFailureMessage } from "./use-failure-message";
import { useTemplateOptions } from "./use-template-options";
import { useWidgetLabels } from "./use-widget-labels";
import { VersionHistory } from "./version-history";
import { WidgetGallery } from "./widget-gallery";
import { WidgetSettings } from "./widget-settings";

/**
 * Dashboard edit mode (S17, UX2b; redesign decisions 2–7, 25, 30). Every change (move, resize, add,
 * remove, hide, settings) stays in a draft that is autosaved to the server for recovery, never
 * published: Done commits it, Cancel discards it. Undo and Redo step through this session's
 * changes. Desktop and tablet keep the gaps people leave and move only widgets that would overlap,
 * with React Grid Layout showing every affected widget's new place live while dragging or resizing
 * (the same `reflow` the keyboard and buttons use, so every route gives the same result). Each
 * screen size keeps its own arrangement, and this edits the one that fits the dashboard's width now;
 * on a phone the same draft can also be arranged as a list.
 *
 * Widget content is inert here: a tap or click arranges, it never opens a widget's links.
 */

export type EditorAction =
  | { readonly kind: "save"; readonly layout: DashboardLayout }
  | { readonly kind: "reset" }
  | { readonly kind: "undo" }
  | { readonly kind: "apply"; readonly option: TemplateOption }
  | {
      readonly kind: "restore";
      readonly versionId: string;
      /** The dashboard revision the history showed as current. */
      readonly expectedRevision: number;
    };

type Confirmation =
  | { readonly kind: "cancel" }
  | { readonly kind: "reset" }
  | { readonly kind: "apply"; readonly option: TemplateOption };

interface History {
  readonly past: readonly DashboardLayout[];
  readonly present: DashboardLayout;
  readonly future: readonly DashboardLayout[];
}

/** Undo steps kept in one edit session. */
const HISTORY_LIMIT = 50;

const sizeKey = { lg: "sizeWide", md: "sizeMedium", sm: "sizeNarrow" } as const satisfies Record<
  Breakpoint,
  string
>;

const statusKey = {
  idle: "draftIdle",
  unsaved: "draftUnsaved",
  saving: "draftSaving",
  saved: "draftSaved",
  failed: "draftFailed",
  local: "draftLocal",
} as const satisfies Record<DraftStatus, string>;

function sameLayout(a: DashboardLayout, b: DashboardLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function samePlacements(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((p) => [p.id, p]));
  return a.every((p) => {
    const other = byId.get(p.id);
    return !!other && other.x === p.x && other.y === p.y && other.w === p.w && other.h === p.h;
  });
}

function newId(): string {
  return crypto.randomUUID();
}

export function DashboardEditor({
  target,
  committed,
  initial,
  resumed,
  draftUnchecked = false,
  baseRevision,
  doneRequest = 0,
  entries,
  sourceHomes,
  canUndo,
  pending,
  onAction,
  onCancel,
}: {
  readonly target: DashboardTarget;
  /** The dashboard as it is saved now: Cancel goes back to it. */
  readonly committed: DashboardLayout;
  /** Where this session starts: the saved layout, or a resumed draft. */
  readonly initial: DashboardLayout;
  /** The session resumed a draft the server already holds. */
  readonly resumed: boolean;
  /** The check for an earlier draft failed: keep no server draft, so none is overwritten. */
  readonly draftUnchecked?: boolean;
  /** The committed revision the draft builds on. */
  readonly baseRevision: number;
  /** Changes when the dashboard asks to run Done again (keeping this draft after a conflict). */
  readonly doneRequest?: number;
  readonly entries: readonly WidgetEntry[];
  readonly sourceHomes: readonly SourceHome[];
  readonly canUndo: boolean;
  /** A save, reset, undo or template is being sent. */
  readonly pending: boolean;
  /** Sends a commit; resolves to whether it succeeded. */
  readonly onAction: (action: EditorAction) => Promise<boolean>;
  /** Leave edit mode and discard the draft (already confirmed when something changed). */
  readonly onCancel: () => void;
}) {
  const t = useTranslations("Dashboard");
  const labels = useWidgetLabels();
  const failureMessage = useFailureMessage();
  const helpId = useId();
  const [history, setHistory] = useState<History>({ past: [], present: initial, future: [] });
  const draft = history.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncementText] = useState("");
  // The same message twice (another "cannot move", or the same position) would not be announced
  // again, so every other message ends in an invisible no-break space (S17-L5).
  const repeat = useRef(false);
  const setAnnouncement = useCallback((text: string) => {
    repeat.current = !repeat.current;
    setAnnouncementText(text === "" ? "" : repeat.current ? `${text}\u00a0` : text);
  }, []);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [gallery, setGallery] = useState<{ readonly slot: Slot | null } | null>(null);
  const [listView, setListView] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Where keyboard focus goes after the arrangement changes: a widget's handle (after a remove, the
  // next one; after an add, the new one), or the Add widget button when none is left, so focus never
  // falls back to the top of the page.
  const focusRequest = useRef<{ readonly id: string | null } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const templates = useTemplateOptions(target);
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const breakpoint = breakpointFor(width);
  const dirty = !sameLayout(draft, committed);
  const kind = target.kind;
  const autosave = useDraftAutosave({
    target,
    layout: draft,
    baseRevision,
    startedSaved: resumed,
    localOnly: draftUnchecked,
  });
  // The drag or resize in progress: the arrangement it started from, so the live preview is always
  // computed from there and never drifts while the pointer moves back and forth.
  const gesture = useRef<{ readonly id: string; readonly base: readonly Placement[] } | null>(null);

  function commit(change: (current: DashboardLayout) => DashboardLayout) {
    setHistory((current) => {
      const next = change(current.present);
      if (next === current.present || sameLayout(next, current.present)) return current;
      return {
        past: [...current.past, current.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
      };
    });
  }

  function undoEdit() {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
    setAnnouncement(t("announceUndone"));
  }

  function redoEdit() {
    setHistory((current) => {
      const [next, ...rest] = current.future;
      if (!next) return current;
      return { past: [...current.past, current.present], present: next, future: rest };
    });
    setAnnouncement(t("announceRedone"));
  }

  // Leaving the page (closing the tab, reloading, following a link) asks first while a change is not
  // safely stored: edited but not yet autosaved, a failed autosave, or no server draft at all. A
  // stored draft is offered again next time, so leaving then is safe (decision 6).
  const unsafe = dirty && !autosave.persisted;
  useEffect(() => {
    if (!unsafe) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      if (!window.confirm(t("leaveConfirm"))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [unsafe, t]);

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const homeName = (homeId: string) => sourceHomes.find((home) => home.id === homeId)?.name;
  function titleOf(widget: DashboardWidget): string {
    const entry = entryById.get(widget.id);
    if (entry) return entry.title;
    const name = labels.name(widget.type);
    const home = widget.source ? homeName(widget.source.homeId) : undefined;
    return home ? t("widgetFromHome", { widget: name, home: isolate(home) }) : name;
  }

  const placements = draft.placements[breakpoint];
  const selected = draft.widgets.find((widget) => widget.id === selectedId) ?? null;
  // Reading and tab order follow what is on screen at this width: top to bottom, then start to end
  // (S17-L6). React Grid Layout places each item by its layout, whatever the DOM order.
  const position = new Map(placements.map((p) => [p.id, p]));
  const ordered = [...draft.widgets].sort((a, b) => {
    const pa = position.get(a.id);
    const pb = position.get(b.id);
    if (!pa || !pb) return 0;
    return pa.y - pb.y || pa.x - pb.x;
  });

  function updatePlacements(next: Placement[], at: Breakpoint = breakpoint) {
    commit((current) => ({
      ...current,
      placements: { ...current.placements, [at]: next },
    }));
  }

  function describePosition(id: string, next: readonly Placement[]): string {
    const widget = draft.widgets.find((w) => w.id === id);
    const p = next.find((candidate) => candidate.id === id);
    if (!widget || !p) return "";
    return t("announcePosition", {
      widget: titleOf(widget),
      row: p.y + 1,
      column: p.x + 1,
      width: p.w,
      height: p.h,
      columns: breakpointColumns[breakpoint],
    });
  }

  function move(id: string, direction: MoveDirection) {
    if (!canMove(placements, id, direction, breakpoint)) {
      setAnnouncement(t("announceCannotMove"));
      return;
    }
    const next = moveWidget(placements, id, direction, breakpoint);
    updatePlacements(next);
    setAnnouncement(describePosition(id, next));
  }

  function resize(id: string, type: WidgetType, direction: ResizeDirection) {
    if (!canResize(placements, id, type, direction, breakpoint)) {
      setAnnouncement(t("announceCannotResize"));
      return;
    }
    const next = resizeWidget(placements, id, type, direction, breakpoint);
    updatePlacements(next);
    setAnnouncement(describePosition(id, next));
  }

  function applyPreset(widget: DashboardWidget, preset: SizePresetId) {
    const size = sizePresets(widget.type, breakpoint).find((candidate) => candidate.id === preset);
    if (!size) return;
    const next = setSize(placements, widget.id, widget.type, size.w, size.h, breakpoint);
    if (!fitsRows(next)) {
      setAnnouncement(t("announceCannotResize"));
      return;
    }
    updatePlacements(next);
    setAnnouncement(describePosition(widget.id, next));
  }

  function handleKey(event: ReactKeyboardEvent, widget: DashboardWidget) {
    const moves: Record<string, MoveDirection> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    const resizes: Record<string, ResizeDirection> = {
      ArrowUp: "shorter",
      ArrowDown: "taller",
      ArrowLeft: "narrower",
      ArrowRight: "wider",
    };
    const direction = event.shiftKey ? resizes[event.key] : moves[event.key];
    if (!direction) return;
    event.preventDefault();
    setSelectedId(widget.id);
    if (event.shiftKey) resize(widget.id, widget.type, direction as ResizeDirection);
    else move(widget.id, direction as MoveDirection);
  }

  // Desktop and tablet: no compaction, overlaps allowed while React Grid Layout moves the dragged
  // widget, and every frame resolved by `reflow` from where the gesture started (decision 5's live
  // preview). The phone keeps React Grid Layout's vertical stacking.
  const compactor = useMemo<Compactor>(
    () =>
      keepsGaps(breakpoint)
        ? {
            type: null,
            allowOverlap: true,
            compact(layout: Layout): Layout {
              const active = gesture.current;
              if (!active) return layout;
              const item = layout.find((candidate) => candidate.i === active.id);
              if (!item) return layout;
              const next = reflow(active.base, [
                { id: item.i, x: item.x, y: item.y, w: item.w, h: item.h },
              ]);
              const byId = new Map(next.map((p) => [p.id, p]));
              return layout.map((candidate) => {
                const p = byId.get(candidate.i);
                return p ? { ...candidate, x: p.x, y: p.y, w: p.w, h: p.h } : candidate;
              });
            },
          }
        : verticalCompactor,
    [breakpoint],
  );

  function startGesture(_layout: Layout, item: LayoutItem | null) {
    if (!item) return;
    gesture.current = { id: item.i, base: placements };
    setDragging(true);
  }

  function endGesture() {
    gesture.current = null;
    setDragging(false);
  }

  // A drag or resize ended: keep the arrangement for this screen size only.
  function handleLayoutChange(layout: Layout) {
    const byId = new Map(layout.map((item) => [item.i, item]));
    const next = placements.flatMap((p) => {
      const item = byId.get(p.id);
      return item ? [{ id: p.id, x: item.x, y: item.y, w: item.w, h: item.h }] : [];
    });
    if (next.length === placements.length && !samePlacements(next, placements)) {
      if (!fitsRows(next)) {
        // Past the last row: the server would refuse it, so keep what was there.
        setAnnouncement(t("announceCannotMove"));
        setHistory((current) => ({ ...current }));
        return;
      }
      updatePlacements(next);
    }
  }

  function updateWidget(id: string, change: Partial<Pick<DashboardWidget, "hidden" | "config">>) {
    commit((current) => ({
      ...current,
      widgets: current.widgets.map((widget) =>
        widget.id === id ? { ...widget, ...change } : widget,
      ),
    }));
  }

  function toggleHidden(widget: DashboardWidget) {
    updateWidget(widget.id, { hidden: !widget.hidden });
    setAnnouncement(
      t(widget.hidden ? "announceShown" : "announceHidden", { widget: titleOf(widget) }),
    );
  }

  useEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const find = () =>
      request.id
        ? (document.querySelector<HTMLElement>(
            `[data-testid="dashboard-edit-widget"][data-widget-id="${request.id}"] [data-testid="dashboard-arrange"]`,
          ) ??
          document.querySelector<HTMLElement>(
            `[data-testid="dashboard-stack-row"][data-widget-id="${request.id}"] button:not(:disabled)`,
          ))
        : null;
    const handle = find();
    if (handle || !request.id) {
      (handle ?? addButton.current)?.focus();
      return;
    }
    // A widget just added appears once the grid has laid it out: try again on the next frame.
    const frame = window.requestAnimationFrame(() => {
      (find() ?? addButton.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [draft, listView]);

  function remove(widget: DashboardWidget) {
    const index = ordered.findIndex((w) => w.id === widget.id);
    const next = ordered[index + 1] ?? ordered[index - 1];
    focusRequest.current = { id: next?.id ?? null };
    commit((current) => removeWidget(current, widget.id));
    setSelectedId(null);
    setAnnouncement(t("announceRemoved", { widget: titleOf(widget) }));
  }

  function add(type: WidgetType, sourceHomeId: string | null) {
    const slot = gallery?.slot ?? null;
    setGallery(null);
    if (!canAddWidget(draft, type)) {
      setAnnouncement(t("addRowsFull", { max: MAX_ROWS }));
      return;
    }
    const widget: DashboardWidget = {
      id: newId(),
      type,
      hidden: false,
      config: defaultConfig(type),
      ...(sourceHomeId ? { source: { homeId: sourceHomeId } } : {}),
    };
    const next = addWidget(draft, widget, slot ? { breakpoint, slot } : undefined);
    commit(() => next);
    setSelectedId(widget.id);
    // The new widget is outlined and focused, so it is easy to find (decision 7).
    focusRequest.current = { id: widget.id };
    const placed = next.placements[breakpoint].find((p) => p.id === widget.id);
    setAnnouncement(
      slot && placed
        ? t("announceAddedHere", {
            widget: titleOf(widget),
            row: placed.y + 1,
            column: placed.x + 1,
          })
        : t("announceAdded", { widget: titleOf(widget) }),
    );
  }

  // One Done at a time: a second press while the first is on its way would commit twice.
  const finishing = useRef(false);

  async function done() {
    if (finishing.current) return;
    finishing.current = true;
    try {
      await finish();
    } finally {
      finishing.current = false;
    }
  }

  async function finish() {
    if (!dirty) {
      // Nothing to commit: leave, dropping a resumed draft that matches the saved layout.
      await autosave.stop();
      onCancel();
      return;
    }
    await autosave.stop();
    const ok = await onAction({ kind: "save", layout: draft });
    if (!ok) autosave.resume();
  }

  // "Replace it with my version" after a conflict: Done again, on the newer revision.
  const doneRef = useRef(done);
  useEffect(() => {
    doneRef.current = done;
  });
  useEffect(() => {
    if (doneRequest > 0) void doneRef.current();
  }, [doneRequest]);

  async function commitNow(action: EditorAction) {
    await autosave.stop();
    const ok = await onAction(action);
    if (!ok) autosave.resume();
  }

  const rglLayouts = Object.fromEntries(
    breakpoints.map((bp) => {
      const types = new Map(draft.widgets.map((w) => [w.id, w.type]));
      const items = draft.placements[bp].flatMap((p): LayoutItem[] => {
        const type = types.get(p.id);
        if (!type) return [];
        const bounds = widgetRegistry[type].sizes[bp];
        return [
          {
            i: p.id,
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            minW: bounds.minW,
            maxW: Math.min(bounds.maxW, breakpointColumns[bp]),
            minH: bounds.minH,
            maxH: bounds.maxH,
          },
        ];
      });
      return [bp, items];
    }),
  );

  // "Add widget here" (decision 3): the free areas inside the arrangement, edit mode only.
  const slots = !dragging && draft.widgets.length > 0 ? emptySlots(placements, breakpoint) : [];
  const cols = breakpointColumns[breakpoint];
  const colWidth = (width - GRID_GAP * (cols - 1)) / cols;

  const confirmTitle =
    confirmation?.kind === "cancel"
      ? t("cancelConfirmTitle")
      : confirmation?.kind === "reset"
        ? t("resetConfirmTitle")
        : confirmation?.kind === "apply"
          ? t("applyConfirmTitle", { template: templateName(confirmation.option) })
          : "";

  function templateName(option: TemplateOption): string {
    if (option.source === "built-in") return t("templateStarter");
    return option.source === "shared"
      ? t("templateShared", { name: isolate(option.name) })
      : option.name;
  }

  function confirmBody(): ReactNode {
    if (!confirmation) return null;
    if (confirmation.kind === "cancel") return <p className="text-body">{t("cancelConfirm")}</p>;
    const widgets =
      confirmation.kind === "reset"
        ? starterLayout(kind).widgets.map((w) => w.type)
        : confirmation.option.widgets;
    // Decision 31: see the arrangement before it replaces the current one.
    const preview =
      confirmation.kind === "reset"
        ? layoutPreview(starterLayout(kind))
        : confirmation.option.preview;
    return (
      <div className="flex flex-col gap-3 text-body">
        <p>{confirmation.kind === "reset" ? t("resetConfirm") : t("applyConfirm")}</p>
        <p>{t("replaceWith", { widgets: widgets.map(labels.name).join(", ") })}</p>
        {preview ? <LayoutPreviewView preview={preview} label={confirmTitle} /> : null}
        {dirty || resumed ? <p>{t("discardUnsaved")}</p> : null}
        <p>{t("undoOnce")}</p>
      </div>
    );
  }

  function confirm() {
    const current = confirmation;
    setConfirmation(null);
    if (!current) return;
    if (current.kind === "cancel") {
      void autosave.stop().then(onCancel);
    } else if (current.kind === "reset") {
      void commitNow({ kind: "reset" });
    } else {
      void commitNow({ kind: "apply", option: current.option });
    }
  }

  const listEditing = breakpoint === "sm" && listView;

  return (
    <div className="flex flex-col gap-6" data-testid="dashboard-editor">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <p id={helpId} className="sr-only">
        {t("keyboardHelp")}
      </p>

      <div
        role="toolbar"
        aria-label={t("editToolbar")}
        className={cx(
          "sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-card border border-line",
          "bg-surface p-2 text-fg shadow-raised",
        )}
        data-testid="dashboard-edit-toolbar"
      >
        <Button
          ref={addButton}
          size="sm"
          onClick={() => {
            setGallery({ slot: null });
          }}
          data-testid="dashboard-add-widget"
        >
          {t("galleryOpen")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={history.past.length === 0 || pending}
          onClick={undoEdit}
          data-testid="dashboard-edit-undo"
        >
          {t("undoEdit")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={history.future.length === 0 || pending}
          onClick={redoEdit}
          data-testid="dashboard-edit-redo"
        >
          {t("redoEdit")}
        </Button>
        <p
          className="min-w-0 flex-1 text-helper text-fg-muted"
          data-testid="dashboard-draft-status"
          data-status={autosave.status}
        >
          {autosave.status === "idle" && !dirty ? t("noChanges") : t(statusKey[autosave.status])}
          {autosave.status === "failed" ? (
            <Button size="sm" variant="ghost" className="ms-2" onClick={autosave.retry}>
              {t("draftRetry")}
            </Button>
          ) : null}
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            if (dirty || resumed) setConfirmation({ kind: "cancel" });
            else void autosave.stop().then(onCancel);
          }}
        >
          {t("cancel")}
        </Button>
        {/* The test id predates the redesign's "Done" label; it is the commit button. */}
        <Button
          size="sm"
          onClick={() => {
            void done();
          }}
          loading={pending}
          data-testid="dashboard-save"
        >
          {t("done")}
        </Button>
      </div>

      <FormAlert tone="info">
        {t("editingSize", { size: t(sizeKey[breakpoint]) })} {t("editHelp")}
      </FormAlert>

      <div className="grid gap-4 lg:grid-cols-2">
        <EditorPanel title={t("panelSelected")}>
          {selected ? (
            <SelectedWidget
              widget={selected}
              contextHomeId={
                target.kind === "home" ? target.homeId : (selected.source?.homeId ?? null)
              }
              title={titleOf(selected)}
              placements={placements}
              breakpoint={breakpoint}
              onMove={(direction) => {
                move(selected.id, direction);
              }}
              onResize={(direction) => {
                resize(selected.id, selected.type, direction);
              }}
              onPreset={(preset) => {
                applyPreset(selected, preset);
              }}
              onConfig={(config) => {
                updateWidget(selected.id, { config });
              }}
              onToggleHidden={() => {
                toggleHidden(selected);
              }}
              onRemove={() => {
                remove(selected);
              }}
            />
          ) : (
            <p className="text-body text-fg-muted">{t("selectHint")}</p>
          )}
        </EditorPanel>

        <EditorPanel title={t("panelLayout")}>
          <LayoutTools
            target={target}
            templates={templates.options}
            templatesLoading={templates.loading}
            templatesFailed={templates.error !== null}
            templateName={templateName}
            dirty={dirty}
            canUndo={canUndo}
            pending={pending}
            failureMessage={failureMessage}
            onApply={(option) => {
              setConfirmation({ kind: "apply", option });
            }}
            onReset={() => {
              setConfirmation({ kind: "reset" });
            }}
            onUndo={() => {
              void commitNow({ kind: "undo" });
            }}
            onHistory={() => {
              setHistoryOpen(true);
            }}
          />
        </EditorPanel>
      </div>

      {breakpoint === "sm" ? (
        <div role="group" aria-label={t("arrangeAs")} className="flex gap-2">
          {[false, true].map((list) => (
            <Button
              key={String(list)}
              size="sm"
              variant={listView === list ? "primary" : "secondary"}
              aria-pressed={listView === list}
              onClick={() => {
                setListView(list);
              }}
              data-testid={list ? "dashboard-view-list" : "dashboard-view-grid"}
            >
              {list ? t("viewList") : t("viewGrid")}
            </Button>
          ))}
        </div>
      ) : null}

      {listEditing ? (
        <StackEditor
          widgets={draft.widgets}
          placements={draft.placements.sm}
          titleOf={titleOf}
          onMove={(widget, direction) => {
            const next = moveInStack(draft.placements.sm, widget.id, direction);
            updatePlacements(next, "sm");
            focusRequest.current = { id: widget.id };
            setAnnouncement(describePosition(widget.id, next));
          }}
          onSize={(widget, preset) => {
            applyPreset(widget, preset);
          }}
          onToggleHidden={toggleHidden}
          onRemove={remove}
        />
      ) : null}

      <div
        ref={containerRef}
        className={cx("relative", listEditing && "hidden")}
        data-testid="dashboard-edit-grid"
      >
        {mounted ? (
          <Responsive
            width={width}
            breakpoint={breakpoint}
            breakpoints={breakpointMinWidths}
            cols={breakpointColumns}
            layouts={rglLayouts}
            rowHeight={ROW_HEIGHT}
            maxRows={MAX_ROWS}
            margin={[GRID_GAP, GRID_GAP]}
            containerPadding={[0, 0]}
            compactor={compactor}
            dragConfig={{ enabled: true, handle: ".dash-drag-handle" }}
            resizeConfig={{ enabled: true, handles: ["se"] }}
            onDragStart={startGesture}
            onResizeStart={startGesture}
            onDragStop={endGesture}
            onResizeStop={endGesture}
            onLayoutChange={handleLayoutChange}
          >
            {ordered.map((widget) => {
              const title = titleOf(widget);
              const entry = entryById.get(widget.id);
              const isSelected = widget.id === selectedId;
              return (
                <div
                  key={widget.id}
                  data-testid="dashboard-edit-widget"
                  data-widget-id={widget.id}
                  className={cx(
                    "rounded-card",
                    isSelected && "outline-2 outline-offset-2 outline-accent",
                  )}
                >
                  <WidgetFrame
                    widget={{ title, unavailable: entry?.unavailable ?? false }}
                    className={widget.hidden ? "opacity-60" : undefined}
                    actions={
                      <>
                        {widget.hidden ? (
                          <span className="rounded-control border border-line px-2 text-helper text-fg-muted">
                            {t("hiddenBadge")}
                          </span>
                        ) : null}
                        {emptyStateModeOf(widget.type, widget.config) === "hide" ? (
                          <span className="rounded-control border border-line px-2 text-helper text-fg-muted">
                            {t("hidesWhenEmptyBadge")}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={cx(
                            "dash-drag-handle flex size-8 shrink-0 cursor-grab items-center justify-center rounded-control",
                            "text-fg-muted hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-accent",
                          )}
                          aria-label={t("arrangeWidget", { widget: title })}
                          aria-describedby={helpId}
                          aria-pressed={isSelected}
                          onClick={() => {
                            setSelectedId(widget.id);
                          }}
                          onKeyDown={(event) => {
                            handleKey(event, widget);
                          }}
                          data-testid="dashboard-arrange"
                        >
                          <DragHandleIcon size="sm" />
                        </button>
                      </>
                    }
                  >
                    {/* Shown as it is, but not usable: arranging never follows a widget's links. */}
                    <div inert>
                      {entry ? (
                        entry.body
                      ) : (
                        <p className="text-body text-fg-muted">
                          {labels.description(widget.type)} {t("previewAfterSave")}
                        </p>
                      )}
                    </div>
                  </WidgetFrame>
                </div>
              );
            })}
          </Responsive>
        ) : null}
        {mounted && width > 0
          ? slots.map((slot) => (
              <button
                key={`${String(slot.x)}:${String(slot.y)}`}
                type="button"
                className={cx(
                  "absolute flex items-center justify-center rounded-card border-2 border-dashed border-line",
                  "text-helper font-medium text-fg-muted hover:border-accent hover:text-accent-fg",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                )}
                style={{
                  // React Grid Layout positions from the left in every direction; so do the slots.
                  left: slot.x * (colWidth + GRID_GAP),
                  top: slot.y * (ROW_HEIGHT + GRID_GAP),
                  width: slot.w * colWidth + (slot.w - 1) * GRID_GAP,
                  height: slot.h * ROW_HEIGHT + (slot.h - 1) * GRID_GAP,
                }}
                aria-label={t("addHereNamed", { row: slot.y + 1, column: slot.x + 1 })}
                onClick={() => {
                  setGallery({ slot });
                }}
                data-testid="dashboard-add-here"
              >
                {t("addHere")}
              </button>
            ))
          : null}
        {draft.widgets.length === 0 ? (
          <p className="text-body text-fg-muted">{t("editEmpty")}</p>
        ) : null}
      </div>

      <WidgetGallery
        open={gallery !== null}
        target={target}
        layout={draft}
        sourceHomes={sourceHomes}
        here={gallery?.slot ? { row: gallery.slot.y + 1, column: gallery.slot.x + 1 } : null}
        fits={(type) => canAddWidget(draft, type)}
        onAdd={add}
        onClose={() => {
          setGallery(null);
        }}
      />

      <Dialog
        open={confirmation !== null}
        onClose={() => {
          setConfirmation(null);
        }}
        title={confirmTitle}
        closeLabel={t("close")}
        size={confirmation?.kind === "cancel" ? "default" : "large"}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmation(null);
              }}
            >
              {confirmation?.kind === "cancel" ? t("keepEditing") : t("cancel")}
            </Button>
            <Button
              variant={confirmation?.kind === "cancel" ? "destructive" : "primary"}
              onClick={confirm}
            >
              {confirmation?.kind === "cancel"
                ? t("discardChanges")
                : confirmation?.kind === "reset"
                  ? t("resetConfirmAction")
                  : t("applyConfirmAction")}
            </Button>
          </>
        }
      >
        {confirmBody()}
      </Dialog>

      <VersionHistory
        open={historyOpen}
        target={target}
        discardsChanges={dirty || resumed}
        pending={pending}
        onClose={() => {
          setHistoryOpen(false);
        }}
        onRestore={(version, expectedRevision) => {
          setHistoryOpen(false);
          void commitNow({ kind: "restore", versionId: version.id, expectedRevision });
        }}
      />
    </div>
  );
}

function EditorPanel({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-widget-padding shadow-raised text-fg"
    >
      <h2 id={id} className="text-body font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SelectedWidget({
  widget,
  contextHomeId,
  title,
  placements,
  breakpoint,
  onMove,
  onResize,
  onPreset,
  onConfig,
  onToggleHidden,
  onRemove,
}: {
  readonly widget: DashboardWidget;
  /** The Home whose data the widget shows (null: the Personal space). */
  readonly contextHomeId: string | null;
  readonly title: string;
  readonly placements: readonly Placement[];
  readonly breakpoint: Breakpoint;
  readonly onMove: (direction: MoveDirection) => void;
  readonly onResize: (direction: ResizeDirection) => void;
  readonly onPreset: (preset: SizePresetId) => void;
  readonly onConfig: (config: Record<string, unknown>) => void;
  readonly onToggleHidden: () => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations("Dashboard");
  const moves: readonly [MoveDirection, string][] = [
    ["up", t("moveUp")],
    ["down", t("moveDown")],
    ["left", t("moveLeft")],
    ["right", t("moveRight")],
  ];
  const resizes: readonly [ResizeDirection, string][] = [
    ["wider", t("resizeWider")],
    ["narrower", t("resizeNarrower")],
    ["taller", t("resizeTaller")],
    ["shorter", t("resizeShorter")],
  ];
  const presets = sizePresets(widget.type, breakpoint);
  const current = placements.find((p) => p.id === widget.id);
  return (
    <div className="flex flex-col gap-4" data-testid="dashboard-selected">
      <p className="text-body font-medium break-words">{title}</p>
      <WidgetSettings widget={widget} contextHomeId={contextHomeId} onChange={onConfig} />
      <div className="flex flex-col gap-2">
        <p className="text-helper text-fg-muted">{t("positionLabel")}</p>
        <div className="flex flex-wrap gap-2">
          {moves.map(([direction, label]) => (
            <Button
              key={direction}
              size="sm"
              variant="secondary"
              disabled={!canMove(placements, widget.id, direction, breakpoint)}
              onClick={() => {
                onMove(direction);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {resizes.map(([direction, label]) => (
            <Button
              key={direction}
              size="sm"
              variant="secondary"
              disabled={!canResize(placements, widget.id, widget.type, direction, breakpoint)}
              onClick={() => {
                onResize(direction);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        {presets.length > 1 ? (
          <div
            role="group"
            aria-label={t("sizePresets")}
            className="flex flex-wrap gap-2"
            data-testid="dashboard-size-presets"
          >
            {presets.map((preset) => {
              const active = current?.w === preset.w && current.h === preset.h;
              return (
                <Button
                  key={preset.id}
                  size="sm"
                  variant={active ? "primary" : "secondary"}
                  aria-pressed={active}
                  onClick={() => {
                    onPreset(preset.id);
                  }}
                >
                  {t(presetKey[preset.id])}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onToggleHidden}>
          {widget.hidden ? t("showWidget") : t("hideWidget")}
        </Button>
        <Button size="sm" variant="destructive" onClick={onRemove}>
          {t("removeWidget")}
        </Button>
      </div>
      <p className="text-helper text-fg-muted">{t("settingsAfterSave")}</p>
    </div>
  );
}
