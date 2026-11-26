"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { DashboardRequestError } from "@/dashboard/api";
import { createTemplate, type DashboardFailure } from "@/dashboard/api";
import { templateNameSchema, type DashboardTarget } from "@/dashboard/schema";
import type { TemplateOption } from "@/dashboard/view-types";
import { isolate } from "@/invitations/format";

import { dashboardTemplatesKey } from "./use-template-options";
import { useWidgetLabels } from "./use-widget-labels";

/**
 * Edit mode's layout tools (S17, UX2c): apply a template, reset to the starter layout, undo the last
 * reset or template, open the version history, and save the saved layout as a template. Template apply, reset and undo commit
 * at once (each undoable once) and end the edit-mode draft; the editor confirms them first.
 */
export function LayoutTools({
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
  onHistory,
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
  /** Opens the version history (decision 32). */
  readonly onHistory: () => void;
}) {
  const t = useTranslations("Dashboard");
  const labels = useWidgetLabels();
  const queryClient = useQueryClient();
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? "");
  const chosen = templates.find((option) => option.key === templateKey) ?? templates[0];
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState<{ name: string; dropped: number } | null>(null);
  const ownNames = templates.flatMap((option) =>
    option.source === "mine" ? [option.name.trim().toLocaleLowerCase()] : [],
  );

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
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={onHistory}
          data-testid="dashboard-history-open"
        >
          {t("versionHistory")}
        </Button>
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
          // Decision 31: clear names. The person's own templates never share a name.
          if (ownNames.includes(parsed.data.toLocaleLowerCase())) {
            setNameError(t("templateNameTaken"));
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
