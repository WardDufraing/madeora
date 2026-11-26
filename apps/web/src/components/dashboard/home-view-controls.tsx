"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { DashboardRequestError, dismissSuggestions, resetHomeView } from "@/dashboard/api";
import type { DashboardLayout, DashboardWidget } from "@/dashboard/layout";
import { layoutPreview } from "@/dashboard/preview";
import { withSuggestions } from "@/dashboard/suggestions";
import type { HomeViews } from "@/dashboard/view-types";

import { LayoutPreviewView } from "./layout-preview";
import { useFailureMessage } from "./use-failure-message";
import { useWidgetLabels } from "./use-widget-labels";

/**
 * Which Home dashboard is on screen, with the way back to the shared default (UX2d; redesign
 * decision 33). "My Home view" is only the person's own; "Shared Home default" is what every member
 * without a view of their own sees. Returning previews the shared default and asks first, because
 * the person's own arrangement, its saved versions and any unsaved draft of it are removed.
 */
export function HomeViewLabel({
  views,
  busy,
  onReturned,
}: {
  readonly views: HomeViews;
  readonly busy: boolean;
  /** The view ended: the page shows the shared default now. */
  readonly onReturned: () => void;
}) {
  const t = useTranslations("DashboardHomeViews");
  const failureMessage = useFailureMessage();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<DashboardRequestError | null>(null);
  const mine = views.showing === "mine";

  async function confirm() {
    setWorking(true);
    setError(null);
    try {
      await resetHomeView(views.homeId);
      setOpen(false);
      onReturned();
    } catch (failure) {
      setError(
        failure instanceof DashboardRequestError ? failure : new DashboardRequestError("failed"),
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="dashboard-view-label">
      <p className="text-helper text-fg-muted">
        <strong className="font-semibold text-fg">
          {mine ? t("labelMine") : t("labelShared")}
        </strong>{" "}
        {mine ? t("hintMine") : t("hintShared")}
      </p>
      {mine ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          data-testid="dashboard-return-shared"
        >
          {t("returnToShared")}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onClose={() => {
          if (!working) setOpen(false);
        }}
        title={t("returnTitle")}
        closeLabel={t("close")}
        size="large"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={working}
              onClick={() => {
                setOpen(false);
              }}
            >
              {t("keepMine")}
            </Button>
            <Button
              loading={working}
              onClick={() => {
                void confirm();
              }}
              data-testid="dashboard-return-confirm"
            >
              {t("returnConfirm")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-body">
          <p>{t("returnBody")}</p>
          <p className="text-helper text-fg-muted">{t("returnLoses")}</p>
          <LayoutPreviewView preview={views.shared.preview} label={t("returnPreviewLabel")} />
          {error ? (
            <FormAlert tone="error" announce>
              {failureMessage(error.failure)}
            </FormAlert>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

/**
 * A quiet note that the shared default added widgets since the person's own view began, with a
 * preview and an explicit "Add to my dashboard" (UX2d; decision 34). Nothing is added, moved or
 * overwritten until they choose: adding opens edit mode on their view with the widgets at the
 * bottom, so it can still be cancelled. Dismissed widgets are not suggested again.
 */
export function SuggestionsNotice({
  views,
  layout,
  busy,
  onAdd,
  onDismissed,
}: {
  readonly views: HomeViews;
  /** The person's own layout, which the additions would join. */
  readonly layout: DashboardLayout;
  readonly busy: boolean;
  readonly onAdd: (widgets: readonly DashboardWidget[]) => void;
  readonly onDismissed: () => void;
}) {
  const t = useTranslations("DashboardHomeViews");
  const labels = useWidgetLabels();
  const failureMessage = useFailureMessage();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<DashboardRequestError | null>(null);
  const suggestions = views.suggestions;
  if (suggestions.length === 0) return null;

  const selected = suggestions.filter((widget) => chosen.has(widget.id));
  const result = withSuggestions(layout, selected);
  const names = suggestions.map((widget) => labels.name(widget.type));

  function review() {
    setChosen(new Set(suggestions.map((widget) => widget.id)));
    setError(null);
    setOpen(true);
  }

  async function dismiss(widgets: readonly DashboardWidget[]) {
    setWorking(true);
    setError(null);
    try {
      await dismissSuggestions(
        views.homeId,
        widgets.map((widget) => widget.id),
      );
      setOpen(false);
      onDismissed();
    } catch (failure) {
      setError(
        failure instanceof DashboardRequestError ? failure : new DashboardRequestError("failed"),
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <section
      aria-label={t("suggestionsLabel")}
      className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface-sunken px-4 py-3"
      data-testid="dashboard-suggestions"
    >
      <p className="min-w-0 flex-1 text-body">
        {t("suggestionsText", { count: suggestions.length, names: names.join(", ") })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={review}
          data-testid="dashboard-suggestions-review"
        >
          {t("suggestionsReview")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || working}
          onClick={() => {
            void dismiss(suggestions);
          }}
          data-testid="dashboard-suggestions-dismiss"
        >
          {t("suggestionsDismiss")}
        </Button>
      </div>
      {error && !open ? (
        <FormAlert tone="error" announce className="w-full">
          {failureMessage(error.failure)}
        </FormAlert>
      ) : null}
      <Dialog
        open={open}
        onClose={() => {
          if (!working) setOpen(false);
        }}
        title={t("reviewTitle")}
        description={t("reviewBody")}
        closeLabel={t("close")}
        size="large"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={working || selected.length === 0}
              onClick={() => {
                void dismiss(selected);
              }}
              data-testid="dashboard-suggestions-dismiss-selected"
            >
              {t("dismissSelected")}
            </Button>
            <Button
              disabled={working || result.added.length === 0}
              onClick={() => {
                setOpen(false);
                onAdd(selected);
              }}
              data-testid="dashboard-suggestions-add"
            >
              {t("addToMine")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("reviewList")}</legend>
            {suggestions.map((widget) => (
              <Checkbox
                key={widget.id}
                label={labels.name(widget.type)}
                description={labels.description(widget.type)}
                checked={chosen.has(widget.id)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(widget.id);
                  else next.delete(widget.id);
                  setChosen(next);
                }}
              />
            ))}
          </fieldset>
          {result.skipped > 0 && selected.length > 0 ? (
            <FormAlert tone="info">{t("someDoNotFit", { count: result.skipped })}</FormAlert>
          ) : null}
          {result.added.length > 0 ? (
            <LayoutPreviewView
              preview={layoutPreview(result.layout)}
              label={t("reviewPreviewLabel")}
            />
          ) : null}
          {error ? (
            <FormAlert tone="error" announce>
              {failureMessage(error.failure)}
            </FormAlert>
          ) : null}
        </div>
      </Dialog>
    </section>
  );
}
