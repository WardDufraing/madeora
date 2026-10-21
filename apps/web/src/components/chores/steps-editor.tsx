"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { CHORE_LIMITS } from "@/chores/schema";

/** One checklist step while editing; `id` keeps an occurrence step's progress, `key` the row. */
export interface StepDraft {
  readonly key: string;
  readonly id: string | null;
  readonly label: string;
  readonly mandatory: boolean;
}

export function newStep(): StepDraft {
  return { key: crypto.randomUUID(), id: null, label: "", mandatory: false };
}

export interface StepsEditorProps {
  readonly value: readonly StepDraft[];
  readonly onChange: (value: StepDraft[]) => void;
  /** A message for the whole list (duplicates, too many). */
  readonly error?: string | undefined;
  /** Per-row messages by position. */
  readonly rowErrors?: readonly (string | undefined)[];
}

/**
 * A checklist's steps (S20): ordered, each a label and whether it is required before completing.
 * Moving uses buttons, so the order changes with a keyboard as well as a pointer.
 */
export function StepsEditor({ value, onChange, error, rowErrors = [] }: StepsEditorProps) {
  const t = useTranslations("Chores");
  const update = (index: number, patch: Partial<StepDraft>) => {
    onChange(value.map((step, at) => (at === index ? { ...step, ...patch } : step)));
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...value];
    const [step] = next.splice(index, 1);
    if (step) next.splice(index + by, 0, step);
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-3" data-testid="chore-steps-editor">
      <legend className="text-body font-medium text-fg">{t("fieldSteps")}</legend>
      <p className="text-helper text-fg-muted">{t("fieldStepsHelp")}</p>
      {value.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {value.map((step, index) => (
            <li
              key={step.key}
              className="flex flex-col gap-2 rounded-card border border-line p-3"
              data-testid="chore-step-row"
            >
              <TextField
                label={t("stepLabel", { number: index + 1 })}
                value={step.label}
                maxLength={CHORE_LIMITS.stepLabel * 2}
                autoComplete="off"
                error={rowErrors[index]}
                onChange={(event) => {
                  update(index, { label: event.target.value });
                }}
              />
              <Checkbox
                label={t("stepMandatory")}
                checked={step.mandatory}
                onChange={(event) => {
                  update(index, { mandatory: event.target.checked });
                }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                  aria-label={t("moveStepUp", { number: index + 1 })}
                >
                  {t("moveUp")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === value.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                  aria-label={t("moveStepDown", { number: index + 1 })}
                >
                  {t("moveDown")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onChange(value.filter((_, at) => at !== index));
                  }}
                  aria-label={t("removeStep", { number: index + 1 })}
                >
                  {t("remove")}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {error ? (
        <p className="text-helper text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={value.length >= CHORE_LIMITS.steps}
          onClick={() => {
            onChange([...value, newStep()]);
          }}
          data-testid="chore-add-step"
        >
          {t("addStep")}
        </Button>
      </div>
    </fieldset>
  );
}
