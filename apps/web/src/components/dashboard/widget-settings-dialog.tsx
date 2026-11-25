"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { DashboardWidget } from "@/dashboard/layout";

import { WidgetSettings } from "./widget-settings";

/**
 * One widget's settings in normal use (UX2a; redesign decision 8), in a side panel (a bottom sheet
 * on a phone) with Apply and Cancel. This is not the dashboard layout draft: applying saves only
 * this widget's configuration (the layout's positions are carried over unchanged), and closing
 * with unsaved changes asks first. The server and the database check the save again.
 */
export function WidgetSettingsDialog({
  widget,
  title,
  contextHomeId,
  pending,
  error,
  onApply,
  onClose,
}: {
  readonly widget: DashboardWidget;
  readonly title: string;
  readonly contextHomeId: string | null;
  readonly pending: boolean;
  /** A failed apply, shown inside the panel so the person's choices are not lost. */
  readonly error: ReactNode;
  readonly onApply: (config: Record<string, unknown>) => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Dashboard");
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const current: DashboardWidget = draft ? { ...widget, config: draft } : widget;

  return (
    <Dialog
      open
      size="side"
      onClose={onClose}
      title={t("settingsTitle", { widget: title })}
      closeLabel={t("close")}
      dirty={draft !== null && !pending}
      discardPrompt={{
        title: t("settingsDiscardTitle"),
        message: t("settingsDiscardMessage"),
        discard: t("settingsDiscard"),
        keep: t("settingsKeep"),
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t("settingsCancel")}
          </Button>
          <Button
            loading={pending}
            disabled={draft === null}
            onClick={() => {
              if (draft) onApply(draft);
            }}
            data-testid="widget-settings-apply"
          >
            {t("settingsApply")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <FormAlert tone="error" announce>
            {error}
          </FormAlert>
        ) : null}
        <WidgetSettings widget={current} contextHomeId={contextHomeId} onChange={setDraft} />
      </div>
    </Dialog>
  );
}
