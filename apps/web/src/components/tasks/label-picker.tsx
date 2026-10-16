"use client";

import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { TASK_LIMITS, type LabelColor } from "@/tasks/schema";

import { LabelChip } from "./label-chip";

export interface LabelOption {
  readonly id: string;
  readonly name: string;
  readonly color: LabelColor | null;
}

/**
 * A searchable multi-select of the context's labels (spec: searchable, clear current selections,
 * keyboard and screen-reader support): a filter field above native checkboxes, and the chosen
 * labels listed as text. Only labels of the task's own context are offered.
 */
export function LabelPicker({
  labels,
  value,
  onChange,
  disabled = false,
}: {
  readonly labels: readonly LabelOption[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly disabled?: boolean;
}) {
  const t = useTranslations("Tasks");
  const [filter, setFilter] = useState("");
  const legendId = useId();
  const chosen = useMemo(() => new Set(value), [value]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return needle === ""
      ? labels
      : labels.filter((label) => label.name.toLocaleLowerCase().includes(needle));
  }, [filter, labels]);
  const full = value.length >= TASK_LIMITS.labelsPerTask;

  if (labels.length === 0) {
    return <p className="text-helper text-fg-muted">{t("labelsNone")}</p>;
  }
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled} aria-labelledby={legendId}>
      <legend id={legendId} className="text-body font-medium text-fg">
        {t("fieldLabels")}
      </legend>
      <p className="text-helper text-fg-muted" aria-live="polite">
        {value.length === 0 ? t("labelsChosenNone") : t("labelsChosen", { count: value.length })}
      </p>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("labelsChosenList")}>
          {labels
            .filter((label) => chosen.has(label.id))
            .map((label) => (
              <li key={label.id}>
                <LabelChip name={label.name} color={label.color} />
              </li>
            ))}
        </ul>
      ) : null}
      {labels.length > 6 ? (
        <TextField
          label={t("labelsFilter")}
          type="search"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          autoComplete="off"
        />
      ) : null}
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="text-helper text-fg-muted">{t("labelsNoMatch")}</p>
        ) : (
          shown.map((label) => (
            <Checkbox
              key={label.id}
              label={label.name}
              checked={chosen.has(label.id)}
              disabled={!chosen.has(label.id) && full}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...value, label.id]
                    : value.filter((id) => id !== label.id),
                );
              }}
            />
          ))
        )}
      </div>
    </fieldset>
  );
}
