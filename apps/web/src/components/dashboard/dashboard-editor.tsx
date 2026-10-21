"use client";

import { DragHandleIcon } from "@madeora/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Responsive, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { DashboardRequestError } from "@/dashboard/api";
import { createTemplate, type DashboardFailure } from "@/dashboard/api";
import {
  canMove,
  canResize,
  moveWidget,
  resizeWidget,
  type MoveDirection,
  type Placement,
  type ResizeDirection,
} from "@/dashboard/geometry";
import {
  addWidget,
  MAX_WIDGETS,
  removeWidget,
  type DashboardLayout,
  type DashboardWidget,
} from "@/dashboard/layout";
import { templateNameSchema, type DashboardTarget } from "@/dashboard/schema";
import { starterLayout } from "@/dashboard/starter";
import type { SourceHome, TemplateOption, WidgetEntry } from "@/dashboard/view-types";
import {
  breakpointColumns,
  breakpointFor,
  breakpointMinWidths,
  breakpoints,
  catalogueFor,
  defaultConfig,
  GRID_GAP,
  ROW_HEIGHT,
  widgetRegistry,
  type Breakpoint,
  type WidgetType,
} from "@/dashboard/widgets";
import { isolate } from "@/invitations/format";

import { WidgetFrame } from "./dashboard-grid";
import { useFailureMessage } from "./use-failure-message";
import { dashboardTemplatesKey, useTemplateOptions } from "./use-template-options";
import { useWidgetLabels } from "./use-widget-labels";
import { WidgetSettings } from "./widget-settings";

/**
 * Dashboard edit mode (S17; spec "Confirmed dashboard edit mode"): drag and resize with React Grid
 * Layout, or the same moves with the keyboard and buttons, with every change announced. Edits stay
 * in a draft until Save; Cancel and leaving the page ask first when something changed. Each screen
 * size keeps its own arrangement, and this edits the one that fits the dashboard's width now.
 *
 * Widget content is inert here: a tap or click arranges, it never opens a widget's links.
 */

export type EditorAction =
  | { readonly kind: "save"; readonly layout: DashboardLayout }
  | { readonly kind: "reset" }
  | { readonly kind: "undo" }
  | { readonly kind: "apply"; readonly option: TemplateOption };

type Confirmation =
  | { readonly kind: "cancel" }
  | { readonly kind: "reset" }
  | { readonly kind: "apply"; readonly option: TemplateOption };

const sizeKey = { lg: "sizeWide", md: "sizeMedium", sm: "sizeNarrow" } as const satisfies Record<
  Breakpoint,
  string
>;

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
  initial,
  entries,
  sourceHomes,
  canUndo,
  pending,
  onAction,
  onDone,
}: {
  readonly target: DashboardTarget;
  /** The saved layout this draft starts from. */
  readonly initial: DashboardLayout;
  readonly entries: readonly WidgetEntry[];
  readonly sourceHomes: readonly SourceHome[];
  readonly canUndo: boolean;
  /** A save, reset, undo or template is being sent. */
  readonly pending: boolean;
  readonly onAction: (action: EditorAction) => void;
  /** Leave edit mode without saving. */
  readonly onDone: () => void;
}) {
  const t = useTranslations("Dashboard");
  const labels = useWidgetLabels();
  const failureMessage = useFailureMessage();
  const helpId = useId();
  const [draft, setDraft] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  // Where keyboard focus goes after a widget is removed: the next widget's handle, or the catalogue
  // when none is left, so focus never falls back to the top of the page.
  const focusAfterRemove = useRef<{ readonly id: string | null } | null>(null);
  const templates = useTemplateOptions(target);
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const breakpoint = breakpointFor(width);
  const dirty = !sameLayout(draft, initial);
  const kind = target.kind;

  // Leaving the page (closing the tab, reloading, following a link) asks first while the draft has
  // unsaved changes. Links inside the app do not unload the page, so they are asked about here too.
  useEffect(() => {
    if (!dirty) return;
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
  }, [dirty, t]);

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

  function updatePlacements(next: Placement[]) {
    setDraft((current) => ({
      ...current,
      placements: { ...current.placements, [breakpoint]: next },
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

  // A drag or resize ended: keep the arrangement for this screen size only.
  function handleLayoutChange(layout: Layout) {
    const byId = new Map(layout.map((item) => [item.i, item]));
    const next = placements.flatMap((p) => {
      const item = byId.get(p.id);
      return item ? [{ id: p.id, x: item.x, y: item.y, w: item.w, h: item.h }] : [];
    });
    if (next.length === placements.length && !samePlacements(next, placements)) {
      updatePlacements(next);
    }
  }

  function updateWidget(id: string, change: Partial<Pick<DashboardWidget, "hidden" | "config">>) {
    setDraft((current) => ({
      ...current,
      widgets: current.widgets.map((widget) =>
        widget.id === id ? { ...widget, ...change } : widget,
      ),
    }));
  }

  useEffect(() => {
    const request = focusAfterRemove.current;
    if (!request) return;
    focusAfterRemove.current = null;
    const handle = request.id
      ? document.querySelector<HTMLElement>(
          `[data-testid="dashboard-edit-widget"][data-widget-id="${request.id}"] [data-testid="dashboard-arrange"]`,
        )
      : null;
    (
      handle ??
      document.querySelector<HTMLElement>(
        '[data-testid="dashboard-catalogue"] button:not(:disabled)',
      )
    )?.focus();
  }, [draft]);

  function remove(widget: DashboardWidget) {
    const index = draft.widgets.findIndex((w) => w.id === widget.id);
    const next = draft.widgets[index + 1] ?? draft.widgets[index - 1];
    focusAfterRemove.current = { id: next?.id ?? null };
    setDraft((current) => removeWidget(current, widget.id));
    setSelectedId(null);
    setAnnouncement(t("announceRemoved", { widget: titleOf(widget) }));
  }

  function add(type: WidgetType, sourceHomeId: string | null) {
    const widget: DashboardWidget = {
      id: newId(),
      type,
      hidden: false,
      config: defaultConfig(type),
      ...(sourceHomeId ? { source: { homeId: sourceHomeId } } : {}),
    };
    setDraft((current) => addWidget(current, widget));
    setSelectedId(widget.id);
    setAnnouncement(t("announceAdded", { widget: titleOf(widget) }));
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
    return (
      <div className="flex flex-col gap-3 text-body">
        <p>{confirmation.kind === "reset" ? t("resetConfirm") : t("applyConfirm")}</p>
        <p>{t("replaceWith", { widgets: widgets.map(labels.name).join(", ") })}</p>
        {dirty ? <p>{t("discardUnsaved")}</p> : null}
        <p>{t("undoOnce")}</p>
      </div>
    );
  }

  function confirm() {
    const current = confirmation;
    setConfirmation(null);
    if (!current) return;
    if (current.kind === "cancel") onDone();
    else if (current.kind === "reset") onAction({ kind: "reset" });
    else onAction({ kind: "apply", option: current.option });
  }

  return (
    <div className="flex flex-col gap-6" data-testid="dashboard-editor">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <p id={helpId} className="sr-only">
        {t("keyboardHelp")}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => {
            onAction({ kind: "save", layout: draft });
          }}
          loading={pending}
          disabled={!dirty}
          data-testid="dashboard-save"
        >
          {t("save")}
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            if (dirty) setConfirmation({ kind: "cancel" });
            else onDone();
          }}
        >
          {t("cancel")}
        </Button>
        <p className="text-helper text-fg-muted">{dirty ? t("unsavedChanges") : t("noChanges")}</p>
      </div>

      <FormAlert tone="info">
        {t("editingSize", { size: t(sizeKey[breakpoint]) })} {t("editHelp")}
      </FormAlert>

      <div className="grid gap-4 lg:grid-cols-3">
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
              onConfig={(config) => {
                updateWidget(selected.id, { config });
              }}
              onToggleHidden={() => {
                updateWidget(selected.id, { hidden: !selected.hidden });
                setAnnouncement(
                  t(selected.hidden ? "announceShown" : "announceHidden", {
                    widget: titleOf(selected),
                  }),
                );
              }}
              onRemove={() => {
                remove(selected);
              }}
            />
          ) : (
            <p className="text-body text-fg-muted">{t("selectHint")}</p>
          )}
        </EditorPanel>

        <EditorPanel title={t("panelAdd")}>
          <AddWidgets
            kind={kind}
            sourceHomes={sourceHomes}
            full={draft.widgets.length >= MAX_WIDGETS}
            onAdd={add}
          />
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
              onAction({ kind: "undo" });
            }}
          />
        </EditorPanel>
      </div>

      <div ref={containerRef} data-testid="dashboard-edit-grid">
        {mounted ? (
          <Responsive
            width={width}
            breakpoint={breakpoint}
            breakpoints={breakpointMinWidths}
            cols={breakpointColumns}
            layouts={rglLayouts}
            rowHeight={ROW_HEIGHT}
            maxRows={200}
            margin={[GRID_GAP, GRID_GAP]}
            containerPadding={[0, 0]}
            dragConfig={{ enabled: true, handle: ".dash-drag-handle" }}
            resizeConfig={{ enabled: true, handles: ["se"] }}
            onLayoutChange={handleLayoutChange}
          >
            {draft.widgets.map((widget) => {
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
        {draft.widgets.length === 0 ? (
          <p className="text-body text-fg-muted">{t("editEmpty")}</p>
        ) : null}
      </div>

      <Dialog
        open={confirmation !== null}
        onClose={() => {
          setConfirmation(null);
        }}
        title={confirmTitle}
        closeLabel={t("close")}
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
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4 text-fg"
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

function AddWidgets({
  kind,
  sourceHomes,
  full,
  onAdd,
}: {
  readonly kind: DashboardTarget["kind"];
  readonly sourceHomes: readonly SourceHome[];
  readonly full: boolean;
  readonly onAdd: (type: WidgetType, sourceHomeId: string | null) => void;
}) {
  const t = useTranslations("Dashboard");
  const labels = useWidgetLabels();
  const [sourceHomeId, setSourceHomeId] = useState(sourceHomes[0]?.id ?? "");
  const catalogue = catalogueFor(kind);
  const needsSource = catalogue.some((item) => item.needsSource);
  const chosenHome = sourceHomes.find((home) => home.id === sourceHomeId) ?? sourceHomes[0];

  return (
    <div className="flex flex-col gap-4">
      {full ? <FormAlert tone="info">{t("addFull", { count: MAX_WIDGETS })}</FormAlert> : null}
      {needsSource && sourceHomes.length > 0 ? (
        <SelectField
          label={t("sourceHome")}
          description={t("sourceHomeDescription")}
          value={chosenHome?.id ?? ""}
          options={sourceHomes.map((home) => ({ value: home.id, label: home.name }))}
          onChange={(event) => {
            setSourceHomeId(event.currentTarget.value);
          }}
        />
      ) : null}
      <ul className="flex flex-col gap-3" data-testid="dashboard-catalogue">
        {catalogue.map(({ type, needsSource: bound }) => {
          const unavailable = bound && !chosenHome;
          return (
            <li key={`${type}:${String(bound)}`} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-body font-medium">
                  {bound && chosenHome
                    ? t("widgetFromHome", {
                        widget: labels.name(type),
                        home: isolate(chosenHome.name),
                      })
                    : kind === "personal" && !bound
                      ? labels.personalName(type)
                      : labels.name(type)}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={full || unavailable}
                  onClick={() => {
                    onAdd(type, bound && chosenHome ? chosenHome.id : null);
                  }}
                  aria-label={t("addWidgetNamed", {
                    widget:
                      bound && chosenHome
                        ? t("widgetFromHome", {
                            widget: labels.name(type),
                            home: isolate(chosenHome.name),
                          })
                        : kind === "personal" && !bound
                          ? labels.personalName(type)
                          : labels.name(type),
                  })}
                >
                  {t("addWidget")}
                </Button>
              </div>
              <p className="text-helper text-fg-muted">{labels.description(type)}</p>
              {unavailable ? <p className="text-helper text-fg-muted">{t("needsHome")}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LayoutTools({
  target,
  templates,
  templatesLoading,
  templatesFailed,
  templateName,
  dirty,
  canUndo,
  pending,
  failureMessage,
  onApply,
  onReset,
  onUndo,
}: {
  readonly target: DashboardTarget;
  readonly templates: readonly TemplateOption[];
  readonly templatesLoading: boolean;
  readonly templatesFailed: boolean;
  readonly templateName: (option: TemplateOption) => string;
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly pending: boolean;
  readonly failureMessage: (failure: DashboardFailure) => string;
  readonly onApply: (option: TemplateOption) => void;
  readonly onReset: () => void;
  readonly onUndo: () => void;
}) {
  const t = useTranslations("Dashboard");
  const labels = useWidgetLabels();
  const queryClient = useQueryClient();
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? "");
  const chosen = templates.find((option) => option.key === templateKey) ?? templates[0];
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState<{ name: string; dropped: number } | null>(null);

  const create = useMutation<{ id: string; dropped: number }, DashboardRequestError, string>({
    mutationFn: (templateName) => createTemplate(templateName, target),
    onSuccess: ({ dropped }, templateName) => {
      setSaved({ name: templateName, dropped });
      setName("");
      // The new template is offered at once, without reloading the page.
      void queryClient.invalidateQueries({ queryKey: dashboardTemplatesKey });
    },
  });

  return (
    <div className="flex flex-col gap-5">
      {templatesLoading ? (
        <p className="text-helper text-fg-muted" role="status">
          {t("templatesLoading")}
        </p>
      ) : null}
      {templatesFailed ? <FormAlert tone="info">{t("templatesFailed")}</FormAlert> : null}
      {templates.length > 0 && chosen ? (
        <div className="flex flex-col gap-2">
          <SelectField
            label={t("templateLabel")}
            value={chosen.key}
            options={templates.map((option) => ({
              value: option.key,
              label: templateName(option),
            }))}
            onChange={(event) => {
              setTemplateKey(event.currentTarget.value);
            }}
          />
          <p className="text-helper text-fg-muted">
            {t("templateContains", { widgets: chosen.widgets.map(labels.name).join(", ") })}
          </p>
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                onApply(chosen);
              }}
              data-testid="dashboard-apply-template"
            >
              {t("applyTemplate")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={onReset}>
          {t("resetToStarter")}
        </Button>
        {canUndo ? (
          <Button size="sm" variant="secondary" disabled={pending || dirty} onClick={onUndo}>
            {t("undoLastChange")}
          </Button>
        ) : null}
      </div>

      <form
        className="flex flex-col gap-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = templateNameSchema.safeParse(name);
          if (!parsed.success) {
            setNameError(t("templateNameInvalid"));
            return;
          }
          setNameError(undefined);
          setSaved(null);
          create.mutate(parsed.data);
        }}
      >
        <TextField
          label={t("templateName")}
          description={dirty ? t("saveTemplateFirst") : t("templateNameDescription")}
          value={name}
          maxLength={80}
          error={nameError}
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
          disabled={dirty}
        />
        <div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={create.isPending}
            disabled={dirty}
          >
            {t("saveAsTemplate")}
          </Button>
        </div>
        {create.isError ? (
          <FormAlert tone="error" announce>
            {failureMessage(create.error.failure)}
          </FormAlert>
        ) : null}
        {saved ? (
          <FormAlert tone="success" announce>
            {t("templateSaved", { name: isolate(saved.name) })}{" "}
            {saved.dropped > 0 ? `${t("templateDropped", { count: saved.dropped })} ` : ""}
            <Link
              href="/settings/dashboard-templates"
              className="font-medium text-accent-fg underline"
            >
              {t("manageTemplates")}
            </Link>
          </FormAlert>
        ) : null}
      </form>
    </div>
  );
}
