"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { MAX_ROWS, MAX_WIDGETS, type DashboardLayout } from "@/dashboard/layout";
import type { DashboardTarget } from "@/dashboard/schema";
import { starterLayout } from "@/dashboard/starter";
import type { SourceHome } from "@/dashboard/view-types";
import {
  allowsMultiple,
  catalogueFor,
  widgetCategories,
  widgetCategory,
  type WidgetCategory,
  type WidgetType,
} from "@/dashboard/widgets";
import { isolate } from "@/invitations/format";

import { useWidgetLabels } from "./use-widget-labels";
import { WidgetPreview } from "./widget-preview";

const categoryKey = {
  today: "categoryToday",
  planning: "categoryPlanning",
  home: "categoryHome",
  personal: "categoryPersonal",
  lifestyle: "categoryLifestyle",
} as const satisfies Record<WidgetCategory, string>;

/** Why a widget cannot be added right now; null when it can. */
type Blocked = "full" | "needs-home" | "already-added" | "rows-full";

/**
 * The widget gallery (UX2b; redesign decisions 3 and 7): a side panel on wide screens and a sheet
 * on phones, with search, the five categories, a Recommended row and an Added state. It offers only
 * what fits this dashboard (`catalogueFor`) and never an Add the person cannot perform: a widget
 * that cannot be added says why instead. Previews are abstract shapes, never anyone's data.
 * Recommendations come from the dashboard's own curated default (the starter layout) and what is
 * already on it, so nothing about the person's behaviour is tracked.
 *
 * Opened from "Add widget here", the same gallery places the widget in that slot (`hereLabel`).
 */
export function WidgetGallery({
  open,
  target,
  layout,
  sourceHomes,
  here,
  fits,
  onAdd,
  onClose,
}: {
  readonly open: boolean;
  readonly target: DashboardTarget;
  /** The draft, for the Added state and the limits. */
  readonly layout: DashboardLayout;
  readonly sourceHomes: readonly SourceHome[];
  /** Set when opened from "Add widget here" (the slot's position, for the title). */
  readonly here: { readonly row: number; readonly column: number } | null;
  /** Whether a widget of this type still fits within the row limit at every width (S17-L1). */
  readonly fits: (type: WidgetType) => boolean;
  readonly onAdd: (type: WidgetType, sourceHomeId: string | null) => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Dashboard");
  const labels = useWidgetLabels();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WidgetCategory | "all">("all");
  const [sourceHomeId, setSourceHomeId] = useState(sourceHomes[0]?.id ?? "");
  // Every opening starts with an empty search and all categories.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setCategory("all");
    }
  }
  const kind = target.kind;
  const catalogue = catalogueFor(kind);
  const needsSource = catalogue.some((item) => item.needsSource);
  const chosenHome = sourceHomes.find((home) => home.id === sourceHomeId) ?? sourceHomes[0];
  const full = layout.widgets.length >= MAX_WIDGETS;

  function nameOf(type: WidgetType, bound: boolean): string {
    if (bound && chosenHome) {
      return t("widgetFromHome", { widget: labels.name(type), home: isolate(chosenHome.name) });
    }
    return kind === "personal" && !bound ? labels.personalName(type) : labels.name(type);
  }

  function addedCount(type: WidgetType, bound: boolean): number {
    return layout.widgets.filter(
      (widget) =>
        widget.type === type &&
        (bound ? widget.source?.homeId === chosenHome?.id : widget.source === undefined),
    ).length;
  }

  function blocked(type: WidgetType, bound: boolean): Blocked | null {
    if (full) return "full";
    if (bound && !chosenHome) return "needs-home";
    if (!allowsMultiple(type) && addedCount(type, bound) > 0) return "already-added";
    if (!fits(type)) return "rows-full";
    return null;
  }

  const needle = query.trim().toLocaleLowerCase();
  const matches = catalogue.filter(({ type, needsSource: bound }) => {
    if (category !== "all" && widgetCategory[type] !== category) return false;
    if (needle === "") return true;
    return `${nameOf(type, bound)} ${labels.description(type)}`
      .toLocaleLowerCase()
      .includes(needle);
  });
  const starterTypes = new Set(starterLayout(kind).widgets.map((widget) => widget.type));
  const recommended =
    needle === "" && category === "all"
      ? catalogue.filter(
          ({ type, needsSource: bound }) =>
            !bound &&
            starterTypes.has(type) &&
            addedCount(type, false) === 0 &&
            blocked(type, false) === null,
        )
      : [];

  function card(type: WidgetType, bound: boolean) {
    const name = nameOf(type, bound);
    const count = addedCount(type, bound);
    const reason = blocked(type, bound);
    return (
      <li
        key={`${type}:${String(bound)}`}
        className="flex gap-3 rounded-card border border-line bg-surface p-3 text-fg"
        data-testid="gallery-card"
        data-widget-type={type}
      >
        <div className="flex shrink-0 flex-col items-center gap-1">
          <WidgetPreview type={type} />
          <span className="text-helper text-fg-muted">{t("galleryPreviewLabel")}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-body font-medium break-words">{name}</p>
            {count > 0 ? (
              <span className="rounded-control border border-line px-2 text-helper text-fg-muted">
                {count > 1 ? t("galleryAddedCount", { count }) : t("galleryAdded")}
              </span>
            ) : null}
          </div>
          <p className="text-helper text-fg-muted">{labels.description(type)}</p>
          {reason ? (
            <p className="text-helper text-fg-muted">
              {reason === "full"
                ? t("addFull", { count: MAX_WIDGETS })
                : reason === "needs-home"
                  ? t("needsHome")
                  : reason === "already-added"
                    ? t("galleryAlreadyAdded")
                    : t("addRowsFull", { max: MAX_ROWS })}
            </p>
          ) : (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onAdd(type, bound && chosenHome ? chosenHome.id : null);
                }}
                aria-label={t("addWidgetNamed", { widget: name })}
              >
                {t("addWidget")}
              </Button>
            </div>
          )}
        </div>
      </li>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="side"
      title={here ? t("galleryTitleHere") : t("galleryTitle")}
      description={here ? t("galleryHereDescription", here) : t("galleryDescription")}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4" data-testid="widget-gallery">
        <TextField
          label={t("gallerySearch")}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          aria-controls={listId}
        />
        <div role="group" aria-label={t("galleryCategories")} className="flex flex-wrap gap-2">
          {(["all", ...widgetCategories] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={category === value}
              onClick={() => {
                setCategory(value);
              }}
              className={cx(
                "min-h-9 rounded-control border px-3 text-helper font-medium",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                category === value
                  ? "border-accent bg-accent-subtle text-accent-fg"
                  : "border-line text-fg hover:bg-accent-subtle",
              )}
            >
              {value === "all" ? t("galleryAll") : t(categoryKey[value])}
            </button>
          ))}
        </div>
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
        {full ? <FormAlert tone="info">{t("addFull", { count: MAX_WIDGETS })}</FormAlert> : null}

        {recommended.length > 0 ? (
          <section className="flex flex-col gap-2" aria-labelledby={`${listId}-recommended`}>
            <h3 id={`${listId}-recommended`} className="text-body font-semibold">
              {t("galleryRecommended")}
            </h3>
            <ul className="flex flex-col gap-2" data-testid="gallery-recommended">
              {recommended.map(({ type, needsSource: bound }) => card(type, bound))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-2" aria-labelledby={`${listId}-all`}>
          <h3 id={`${listId}-all`} className="text-body font-semibold">
            {category === "all" ? t("galleryEverything") : t(categoryKey[category])}
          </h3>
          <p className="sr-only" role="status" aria-live="polite">
            {t("galleryResults", { count: matches.length })}
          </p>
          {matches.length === 0 ? (
            <p className="text-body text-fg-muted">{t("galleryNoResults")}</p>
          ) : (
            <ul id={listId} className="flex flex-col gap-2" data-testid="dashboard-catalogue">
              {matches.map(({ type, needsSource: bound }) => card(type, bound))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
