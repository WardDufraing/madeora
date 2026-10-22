"use client";

import { latePolicies, POINTS_LIMITS, type LatePolicy } from "@madeora/domain/points";
import { useTranslations } from "next-intl";
import type { UseFormRegisterReturn } from "react-hook-form";
import { z } from "zod";

import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { ChorePointsInput } from "@/points/chore-points";

/** A chore's points as a form holds them: whole numbers typed as text. */
export interface ChorePointsDraft {
  readonly points: string;
  readonly latePolicy: LatePolicy;
  readonly latePoints: string;
}

export const noPointsDraft: ChorePointsDraft = { points: "0", latePolicy: "full", latePoints: "" };

export function pointsDraft(setting: {
  readonly points: number;
  readonly latePolicy: LatePolicy;
  readonly latePoints: number | null;
}): ChorePointsDraft {
  return {
    points: String(setting.points),
    latePolicy: setting.latePolicy,
    latePoints: setting.latePoints === null ? "" : String(setting.latePoints),
  };
}

const wholePoints = /^\d{1,4}$/;

/**
 * The draft as the API takes it: 0-1000 points; a reduced policy names an amount up to them (the
 * amount is dropped for the other policies). Errors: `points`, `latePoints`.
 */
export const chorePointsDraftSchema = z
  .object({ points: z.string(), latePolicy: z.enum(latePolicies), latePoints: z.string() })
  .transform((draft, context): ChorePointsInput => {
    const points = draft.points.trim() === "" ? 0 : Number(draft.points.trim());
    if (!wholePoints.test(draft.points.trim() || "0") || points > POINTS_LIMITS.chorePoints) {
      context.addIssue({ code: "custom", message: "points", path: ["points"] });
      return z.NEVER;
    }
    if (draft.latePolicy !== "reduced") {
      return { points, latePolicy: draft.latePolicy, latePoints: null };
    }
    const late = Number(draft.latePoints.trim());
    if (!wholePoints.test(draft.latePoints.trim()) || late > points) {
      context.addIssue({ code: "custom", message: "latePoints", path: ["latePoints"] });
      return z.NEVER;
    }
    return { points, latePolicy: "reduced", latePoints: late };
  });

export interface PointsFieldsProps {
  readonly register: {
    readonly points: UseFormRegisterReturn;
    readonly latePolicy: UseFormRegisterReturn;
    readonly latePoints: UseFormRegisterReturn;
  };
  /** The policy chosen now: the reduced amount is asked only for `reduced`. */
  readonly policy: LatePolicy;
  readonly errors: {
    readonly points?: { readonly message?: string | undefined } | undefined;
    readonly latePoints?: { readonly message?: string | undefined } | undefined;
  };
  /** Shown under the group: when changes apply (prospective) or that a template only suggests. */
  readonly help?: string;
}

/**
 * A chore's points (S23; spec "Confirmed chore point values" and "Confirmed late completion point
 * policy"): the base value and what a late completion earns: full, a reduced amount, or nothing.
 */
export function PointsFields({ register, policy, errors, help }: PointsFieldsProps) {
  const t = useTranslations("Points");
  const message = (error: { readonly message?: string | undefined } | undefined) =>
    error?.message === "points"
      ? t("fieldPointsInvalid")
      : error?.message === "latePoints"
        ? t("fieldLatePointsInvalid")
        : undefined;
  return (
    <fieldset className="flex flex-col gap-3" data-testid="chore-points-fields">
      <legend className="mb-1 text-body font-semibold text-fg">{t("fieldsLegend")}</legend>
      {help ? <p className="text-helper text-fg-muted">{help}</p> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          type="number"
          inputMode="numeric"
          min={0}
          max={POINTS_LIMITS.chorePoints}
          label={t("fieldPoints")}
          description={t("fieldPointsHelp")}
          error={message(errors.points)}
          data-testid="chore-points"
          {...register.points}
        />
        <SelectField
          label={t("fieldLatePolicy")}
          options={latePolicies.map((value) => ({ value, label: t(`latePolicy_${value}`) }))}
          data-testid="chore-late-policy"
          {...register.latePolicy}
        />
        {policy === "reduced" ? (
          <TextField
            type="number"
            inputMode="numeric"
            min={0}
            max={POINTS_LIMITS.chorePoints}
            label={t("fieldLatePoints")}
            error={message(errors.latePoints)}
            data-testid="chore-late-points"
            {...register.latePoints}
          />
        ) : null}
      </div>
    </fieldset>
  );
}
