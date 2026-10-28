"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { isMealDate, isoWeekday, MEAL_LIMITS, type MealCadence } from "@madeora/domain/meals";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import {
  MEAL_ENTRIES_ENDPOINT,
  MEAL_RECIPES_ENDPOINT,
  MEAL_SERIES_ENDPOINT,
  mealEntryEndpoint,
  mealOccurrenceEndpoint,
  mealSeriesEndpoint,
  MealRequestError,
  sendMealRequest,
  type MealCollision,
  type MealEntry,
  type MealOccupied,
  type MealOccurrence,
  type MealPlan,
  type MealRecipeOption,
  type MealSeries,
  type MealSeriesPreview,
} from "@/meals/api";
import { formatMealDate, mealKey, mealKeys, newId } from "@/meals/format";
import { mealNotesSchema, mealTitleSchema } from "@/meals/schema";
import { recipePath } from "@/recipes/format";
import { TRASH_RESTORE_ENDPOINT, type RestoreResponse } from "@/trash/api";

import { useMealMutation } from "./use-meal-mutation";
import { useMealTexts } from "./use-meal-texts";

/** What the dialog opens on: an empty slot, a meal, one occurrence, or a whole repeating meal. */
export type MealDialogTarget =
  | { readonly mode: "new"; readonly date: string; readonly slotId: string }
  | { readonly mode: "entry"; readonly meal: MealEntry }
  | { readonly mode: "occurrence"; readonly meal: MealOccurrence }
  | { readonly mode: "series"; readonly series: MealSeries; readonly from: string };

export interface MealDialogProps {
  readonly target: MealDialogTarget;
  readonly plan: MealPlan;
  readonly homeId: string | null;
  readonly onClose: () => void;
}

const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
/** The recipe option that keeps a recipe the person can no longer see. */
const KEEP = "keep";

interface FormValues {
  kind: "recipe" | "custom";
  recipeId: string;
  title: string;
  servings: string;
  notes: string;
  date: string;
  slotId: string;
  repeat: "none" | MealCadence;
  weekdays: string[];
  endOn: string;
  scope: "one" | "future";
}

interface Content {
  readonly recipeId: string | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly servings: number | null;
}

interface Schedule {
  readonly slotId: string;
  readonly cadence: MealCadence;
  readonly weekdays: readonly number[] | null;
  readonly endOn: string | null;
}

type Step =
  | { readonly kind: "form" }
  | { readonly kind: "occupied"; readonly occupied: MealOccupied; readonly values: FormValues }
  | {
      readonly kind: "collisions";
      readonly preview: MealSeriesPreview;
      readonly values: FormValues;
      readonly changed: boolean;
    }
  | { readonly kind: "remove" };

function contentOf(values: FormValues): Content {
  const notes = values.notes.trim() === "" ? null : values.notes;
  if (values.kind === "custom") {
    return { recipeId: null, title: values.title, notes, servings: null };
  }
  return {
    recipeId: values.recipeId === KEEP ? null : values.recipeId,
    title: null,
    notes,
    servings: values.servings.trim() === "" ? null : Number(values.servings),
  };
}

function scheduleOf(values: FormValues, cadence: MealCadence): Schedule {
  return {
    slotId: values.slotId,
    cadence,
    weekdays:
      cadence === "daily"
        ? null
        : cadence === "weekly"
          ? [isoWeekday(values.date)]
          : values.weekdays.map(Number).sort((a, b) => a - b),
    endOn: values.endOn === "" ? null : values.endOn,
  };
}

/** Field errors as codes, checked like the API checks them (which checks everything again). */
function validate(
  values: FormValues,
  repeating: boolean,
): Partial<Record<keyof FormValues, string>> {
  const errors: Partial<Record<keyof FormValues, string>> = {};
  if (values.kind === "custom") {
    const title = mealTitleSchema.safeParse(values.title);
    if (!title.success) errors.title = title.error.issues[0]?.message ?? "invalid";
  } else {
    if (values.recipeId === "") errors.recipeId = "recipeRequired";
    if (values.servings.trim() !== "") {
      const servings = Number(values.servings);
      if (!Number.isInteger(servings) || servings < 1 || servings > MEAL_LIMITS.maxServings) {
        errors.servings = "servings";
      }
    }
  }
  if (values.notes.trim() !== "" && !mealNotesSchema.safeParse(values.notes).success) {
    errors.notes = mealNotesSchema.safeParse(values.notes).error?.issues[0]?.message ?? "invalid";
  }
  if (!isMealDate(values.date)) errors.date = "invalid";
  if (values.slotId === "") errors.slotId = "required";
  if (repeating) {
    if (values.repeat === "weekdays" && values.weekdays.length === 0) {
      errors.weekdays = "weekdaysRequired";
    }
    if (values.endOn !== "") {
      if (!isMealDate(values.endOn)) errors.endOn = "invalid";
      else if (values.endOn < values.date) errors.endOn = "endBeforeStart";
    }
  }
  return errors;
}

/**
 * The meal dialog (S27): plan a meal in a slot (a recipe visible from this planner, or a custom
 * meal), optionally repeating; edit or move a meal; for one occurrence of a repeating meal, choose
 * "Only this one" (it becomes a meal of its own, the rest continues) or "This and later ones";
 * remove a meal (to the trash, with Undo) or skip an occurrence (with Undo). A taken slot is never
 * overwritten: the person sees what is there and chooses to keep it or replace it. People who may
 * only view the plan see the meal's details.
 */
export function MealDialog({ target, plan, homeId, onClose }: MealDialogProps) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const texts = useMealTexts();
  const toast = useToast();
  const editable = plan.access !== "view";
  const [step, setStep] = useState<Step>({ kind: "form" });
  // One client id per dialog, so a retried save never makes a second meal or series.
  const [ids] = useState(() => ({ entry: newId(), series: newId() }));

  const meal = target.mode === "entry" || target.mode === "occurrence" ? target.meal : null;
  const series =
    target.mode === "series"
      ? target.series
      : target.mode === "occurrence"
        ? (plan.series.find((candidate) => candidate.id === target.meal.seriesId) ?? null)
        : null;
  const source = meal ?? series;
  const keepable = source?.type === "recipe" && source.recipe === null;
  const startDate =
    target.mode === "new" ? target.date : target.mode === "series" ? target.from : target.meal.date;

  const defaults: FormValues = {
    kind: source?.type ?? "recipe",
    recipeId: source?.type === "recipe" ? (source.recipe?.id ?? KEEP) : "",
    title: source?.type === "custom" ? (source.title ?? "") : "",
    servings: source?.servings == null ? "" : String(source.servings),
    notes: source?.notes ?? "",
    date: startDate,
    slotId: target.mode === "new" ? target.slotId : (meal?.slotId ?? series?.slotId ?? ""),
    repeat:
      target.mode === "series"
        ? target.series.cadence
        : target.mode === "occurrence"
          ? (series?.cadence ?? "weekly")
          : "none",
    weekdays: (series?.weekdays ?? [isoWeekday(startDate)]).map(String),
    endOn: series?.endOn ?? "",
    scope: target.mode === "series" ? "future" : "one",
  };
  const form = useForm<FormValues>({ defaultValues: defaults });
  const values = useWatch({ control: form.control }) as FormValues;
  const errors = form.formState.errors;
  const repeating =
    target.mode === "series" ||
    (target.mode === "new" && values.repeat !== "none") ||
    (target.mode === "occurrence" && values.scope === "future");

  const recipes = useQuery<{ recipes: readonly MealRecipeOption[] }, MealRequestError>({
    queryKey: mealKeys.recipes(homeId),
    queryFn: () =>
      sendMealRequest(
        "GET",
        homeId ? `${MEAL_RECIPES_ENDPOINT}?homeId=${homeId}` : MEAL_RECIPES_ENDPOINT,
      ),
    enabled: editable,
    staleTime: 60_000,
  });

  const done = (message: string) => {
    onClose();
    toast.show({ title: message, tone: "success" });
  };

  const saveEntry = useMealMutation(
    `meal:${ids.entry}`,
    async ({ values: input, replace }: { values: FormValues; replace: string | null }) => {
      const content = contentOf(input);
      if (target.mode === "entry") {
        return sendMealRequest("PATCH", mealEntryEndpoint(target.meal.id), {
          revision: target.meal.revision,
          date: input.date,
          slotId: input.slotId,
          ...content,
          replace,
        });
      }
      if (target.mode === "occurrence") {
        return sendMealRequest(
          "PUT",
          mealOccurrenceEndpoint(target.meal.recurrenceId, target.meal.date),
          { entryId: ids.entry, date: input.date, slotId: input.slotId, ...content, replace },
        );
      }
      return sendMealRequest("POST", MEAL_ENTRIES_ENDPOINT, {
        id: ids.entry,
        homeId,
        date: input.date,
        slotId: input.slotId,
        ...content,
        replace,
      });
    },
    () => {
      done(t("mealSaved"));
    },
  );

  const previewSeries = useMealMutation(
    `meal-series-preview:${ids.series}`,
    (input: FormValues) => {
      const schedule = scheduleOf(input, input.repeat === "none" ? "daily" : input.repeat);
      if (target.mode === "new") {
        return sendMealRequest<{ preview: MealSeriesPreview }>("POST", MEAL_SERIES_ENDPOINT, {
          action: "preview",
          homeId,
          startOn: input.date,
          ...schedule,
        });
      }
      return sendMealRequest<{ preview: MealSeriesPreview }>(
        "PATCH",
        mealSeriesEndpoint(series?.id ?? ""),
        { action: "preview", homeId, from: input.date, ...schedule },
      );
    },
  );

  const saveSeries = useMealMutation(
    `meal-series:${series?.id ?? ids.series}`,
    ({
      values: input,
      token,
      decisions,
    }: {
      values: FormValues;
      token: string;
      decisions: Record<string, "skip" | "replace">;
    }) => {
      const schedule = scheduleOf(input, input.repeat === "none" ? "daily" : input.repeat);
      const content = contentOf(input);
      if (target.mode === "new") {
        return sendMealRequest("POST", MEAL_SERIES_ENDPOINT, {
          action: "create",
          id: ids.series,
          homeId,
          startOn: input.date,
          ...schedule,
          ...content,
          token,
          decisions,
        });
      }
      return sendMealRequest("PATCH", mealSeriesEndpoint(series?.id ?? ""), {
        action: "editFuture",
        revision: series?.revision ?? 0,
        from: input.date,
        ...schedule,
        ...content,
        token,
        decisions,
      });
    },
    () => {
      done(t("repeatingSaved"));
    },
  );

  const restore = async (send: () => Promise<unknown>, failed: string) => {
    try {
      await send();
      toast.show({ title: t("mealRestored"), tone: "success" });
    } catch {
      toast.show({ title: failed, tone: "error" });
    }
  };

  const remove = useMealMutation(
    `meal:${meal ? mealKey(meal) : ids.entry}`,
    async () => {
      if (target.mode === "entry") {
        return sendMealRequest<{ entryId: string | null }>(
          "DELETE",
          mealEntryEndpoint(target.meal.id),
          { revision: target.meal.revision },
        );
      }
      if (target.mode === "occurrence") {
        await sendMealRequest(
          "DELETE",
          mealOccurrenceEndpoint(target.meal.recurrenceId, target.meal.date),
          {},
        );
      }
      return { entryId: null };
    },
    ({ entryId }) => {
      onClose();
      if (target.mode === "occurrence") {
        const { recurrenceId, date } = target.meal;
        toast.show({
          title: t("occurrenceSkipped"),
          tone: "success",
          action: {
            label: t("undo"),
            onAction: () => {
              void restore(
                () => sendMealRequest("POST", mealOccurrenceEndpoint(recurrenceId, date, true), {}),
                t("occurrenceNotRestored"),
              );
            },
          },
        });
        return;
      }
      toast.show({
        title: t("mealRemoved"),
        tone: "success",
        ...(entryId
          ? {
              action: {
                label: t("undo"),
                onAction: () => {
                  void restore(
                    () =>
                      sendMealRequest<RestoreResponse>("POST", TRASH_RESTORE_ENDPOINT, {
                        entryIds: [entryId],
                      }).then((answer) => {
                        if (answer.results[0]?.outcome !== "restored") {
                          throw new MealRequestError("failed");
                        }
                      }),
                    t("mealNotRestored"),
                  );
                },
              },
            }
          : {}),
      });
    },
  );

  const endSeries = useMealMutation(
    `meal-series:${series?.id ?? ids.series}`,
    () =>
      sendMealRequest("PATCH", mealSeriesEndpoint(series?.id ?? ""), {
        action: "end",
        revision: series?.revision ?? 0,
        from: startDate,
      }),
    () => {
      done(t("repeatingEnded"));
    },
  );

  const submit = (input: FormValues) => {
    const found = validate(input, repeating);
    form.clearErrors();
    const fields = Object.entries(found) as [keyof FormValues, string][];
    if (fields.length > 0) {
      for (const [field, code] of fields) form.setError(field, { message: code });
      form.setFocus(fields[0]?.[0] ?? "title");
      return;
    }
    if (repeating) {
      previewSeries.mutate(input, {
        onSuccess: ({ preview }) => {
          setStep({ kind: "collisions", preview, values: input, changed: false });
        },
      });
      return;
    }
    saveEntry.mutate(
      { values: input, replace: null },
      {
        onError: (error) => {
          if (error.failure === "occupied" && error.details.occupied) {
            setStep({ kind: "occupied", occupied: error.details.occupied, values: input });
          }
        },
      },
    );
  };

  const slotOptions = plan.slots
    .filter((slot) => slot.enabled || slot.id === defaults.slotId)
    .map((slot) => ({
      value: slot.id,
      label: slot.enabled
        ? texts.slotName(slot)
        : t("slotDisabledOption", { slot: texts.slotName(slot) }),
    }));

  const title =
    target.mode === "new"
      ? t("addMealTitle")
      : !editable
        ? t("mealTitle")
        : target.mode === "series"
          ? t("editRepeatingTitle")
          : t("editMealTitle");
  const description =
    target.mode === "series"
      ? t("editRepeatingDescription", { date: formatMealDate(target.from, locale) })
      : t("mealDialogDescription", {
          date: formatMealDate(startDate, locale),
          slot: texts.slotName(plan.slots.find((slot) => slot.id === defaults.slotId)),
        });

  return (
    <Dialog open onClose={onClose} title={title} description={description} closeLabel={t("close")}>
      <div className="flex flex-col gap-5" data-testid="meal-dialog">
        {!editable ? (
          <MealFacts source={source} homeId={homeId} />
        ) : step.kind === "occupied" ? (
          <OccupiedChoice
            occupied={step.occupied}
            busy={saveEntry.busy}
            error={
              saveEntry.error && saveEntry.error.failure !== "occupied"
                ? texts.failure(saveEntry.error.failure)
                : null
            }
            onKeep={() => {
              saveEntry.reset();
              setStep({ kind: "form" });
            }}
            onReplace={() => {
              saveEntry.mutate(
                { values: step.values, replace: step.occupied.replaceKey },
                {
                  onError: (error) => {
                    if (error.failure === "occupied" && error.details.occupied) {
                      setStep({ ...step, occupied: error.details.occupied });
                    }
                  },
                },
              );
            }}
          />
        ) : step.kind === "collisions" ? (
          <CollisionChoice
            key={step.preview.token}
            preview={step.preview}
            changed={step.changed}
            busy={saveSeries.busy || previewSeries.busy}
            error={
              saveSeries.error && saveSeries.error.failure !== "conflicts"
                ? texts.failure(saveSeries.error.failure)
                : null
            }
            onBack={() => {
              saveSeries.reset();
              setStep({ kind: "form" });
            }}
            onConfirm={(decisions) => {
              saveSeries.mutate(
                { values: step.values, token: step.preview.token, decisions },
                {
                  onError: (error) => {
                    // The plan changed since the preview: show the current collisions again.
                    if (error.failure !== "conflicts") return;
                    previewSeries.mutate(step.values, {
                      onSuccess: ({ preview }) => {
                        saveSeries.reset();
                        setStep({
                          kind: "collisions",
                          preview,
                          values: step.values,
                          changed: true,
                        });
                      },
                    });
                  },
                },
              );
            }}
          />
        ) : step.kind === "remove" ? (
          <div className="flex flex-col gap-3">
            <p className="text-body text-fg">
              {target.mode === "occurrence" ? t("skipQuestion") : t("removeQuestion")}
            </p>
            <p className="text-helper text-fg-muted">
              {target.mode === "occurrence" ? t("skipExplanation") : t("removeTrash")}
            </p>
            {remove.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(remove.error.failure)}
              </FormAlert>
            ) : null}
            {endSeries.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(endSeries.error.failure)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setStep({ kind: "form" });
                }}
              >
                {t("cancel")}
              </Button>
              {target.mode === "occurrence" && series ? (
                <Button
                  variant="secondary"
                  loading={endSeries.busy}
                  onClick={() => {
                    endSeries.mutate(undefined);
                  }}
                  data-testid="meal-end-series"
                >
                  {t("endFromHere")}
                </Button>
              ) : null}
              <Button
                variant="destructive"
                loading={remove.busy}
                onClick={() => {
                  remove.mutate(undefined);
                }}
                data-testid="meal-remove-confirm"
              >
                {target.mode === "occurrence" ? t("skipOccurrence") : t("removeMeal")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              void form.handleSubmit(submit)(event);
            }}
          >
            {target.mode === "occurrence" ? (
              <fieldset className="flex flex-col gap-2" data-testid="meal-scope">
                <legend className="text-body font-medium text-fg">{t("scopeLegend")}</legend>
                <label className="flex items-start gap-2 text-body text-fg">
                  <input
                    type="radio"
                    value="one"
                    className="mt-1 size-4 accent-accent"
                    {...form.register("scope")}
                  />
                  <span>
                    {t("scopeOne")}
                    <span className="block text-helper text-fg-muted">{t("scopeOneHint")}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-body text-fg">
                  <input
                    type="radio"
                    value="future"
                    className="mt-1 size-4 accent-accent"
                    data-testid="meal-scope-future"
                    {...form.register("scope")}
                  />
                  <span>
                    {t("scopeFuture")}
                    <span className="block text-helper text-fg-muted">{t("scopeFutureHint")}</span>
                  </span>
                </label>
              </fieldset>
            ) : null}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-body font-medium text-fg">{t("kindLegend")}</legend>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-body text-fg">
                  <input
                    type="radio"
                    value="recipe"
                    className="size-4 accent-accent"
                    data-testid="meal-kind-recipe"
                    {...form.register("kind")}
                  />
                  {t("kindRecipe")}
                </label>
                <label className="flex items-center gap-2 text-body text-fg">
                  <input
                    type="radio"
                    value="custom"
                    className="size-4 accent-accent"
                    data-testid="meal-kind-custom"
                    {...form.register("kind")}
                  />
                  {t("kindCustom")}
                </label>
              </div>
            </fieldset>
            {values.kind === "recipe" ? (
              <>
                <SelectField
                  label={t("fieldRecipe")}
                  {...(recipes.isPending ? { description: t("recipesLoading") } : {})}
                  error={texts.field(errors.recipeId?.message)}
                  options={[
                    { value: "", label: t("recipeChoose") },
                    ...(keepable ? [{ value: KEEP, label: t("recipeKeepUnavailable") }] : []),
                    ...(recipes.data?.recipes ?? []).map((recipe) => ({
                      value: recipe.id,
                      label: recipe.name,
                    })),
                  ]}
                  data-testid="meal-recipe"
                  {...form.register("recipeId")}
                />
                {recipes.error ? (
                  <FormAlert tone="error">{t("recipesFailed")}</FormAlert>
                ) : recipes.data?.recipes.length === 0 ? (
                  <p className="text-helper text-fg-muted">{t("recipesNone")}</p>
                ) : null}
                <TextField
                  label={t("fieldServings")}
                  description={t("fieldServingsHint")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MEAL_LIMITS.maxServings}
                  error={texts.field(errors.servings?.message)}
                  data-testid="meal-servings"
                  {...form.register("servings")}
                />
              </>
            ) : (
              <TextField
                label={t("fieldTitle")}
                autoComplete="off"
                maxLength={MEAL_LIMITS.title * 2}
                error={texts.field(errors.title?.message)}
                data-testid="meal-title"
                {...form.register("title")}
              />
            )}
            <TextArea
              label={t("fieldNotes")}
              rows={2}
              error={texts.field(errors.notes?.message)}
              data-testid="meal-notes"
              {...form.register("notes")}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={repeating ? t("fieldStartOn") : t("fieldDate")}
                type="date"
                error={texts.field(errors.date?.message)}
                data-testid="meal-date"
                {...form.register("date")}
              />
              <SelectField
                label={t("fieldSlot")}
                options={slotOptions}
                error={texts.field(errors.slotId?.message)}
                data-testid="meal-slot"
                {...form.register("slotId")}
              />
            </div>
            {target.mode === "new" || repeating ? (
              <SelectField
                label={t("fieldRepeat")}
                options={[
                  ...(target.mode === "new" ? [{ value: "none", label: t("repeatNone") }] : []),
                  { value: "daily", label: t("cadenceDaily") },
                  { value: "weekdays", label: t("cadenceWeekdays") },
                  { value: "weekly", label: t("cadenceWeekly") },
                ]}
                data-testid="meal-repeat"
                {...form.register("repeat")}
              />
            ) : null}
            {repeating && values.repeat === "weekdays" ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-body font-medium text-fg">{t("fieldWeekdays")}</legend>
                <div className="flex flex-wrap gap-3">
                  {weekdays.map((day) => (
                    <label key={day} className="flex items-center gap-1.5 text-body text-fg">
                      <input
                        type="checkbox"
                        value={String(day)}
                        className="size-4 accent-accent"
                        {...form.register("weekdays")}
                      />
                      {texts.weekdayName(day, locale)}
                    </label>
                  ))}
                </div>
                {errors.weekdays?.message ? (
                  <p className="text-helper text-danger" role="alert">
                    {texts.field(errors.weekdays.message)}
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            {repeating && values.repeat === "weekly" && isMealDate(values.date) ? (
              <p className="text-helper text-fg-muted">
                {t("weeklyOn", { day: texts.weekdayName(isoWeekday(values.date), locale) })}
              </p>
            ) : null}
            {repeating ? (
              <TextField
                label={t("fieldEndOn")}
                description={t("fieldEndOnHint")}
                type="date"
                error={texts.field(errors.endOn?.message)}
                data-testid="meal-end-on"
                {...form.register("endOn")}
              />
            ) : null}
            {saveEntry.error && saveEntry.error.failure !== "occupied" ? (
              <FormAlert tone="error" announce>
                {saveEntry.error.failure === "conflict"
                  ? t("mealChangedMeanwhile")
                  : texts.failure(saveEntry.error.failure)}
              </FormAlert>
            ) : null}
            {previewSeries.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(previewSeries.error.failure)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {target.mode === "entry" || target.mode === "occurrence" ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      remove.reset();
                      endSeries.reset();
                      setStep({ kind: "remove" });
                    }}
                    data-testid="meal-remove"
                  >
                    {target.mode === "occurrence" ? t("skipOccurrence") : t("removeMeal")}
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={onClose}>
                  {t("cancel")}
                </Button>
                <Button
                  type="submit"
                  loading={saveEntry.busy || previewSeries.busy}
                  data-testid="meal-save"
                >
                  {repeating ? t("continue") : t("save")}
                </Button>
              </div>
            </div>
            {source && source.type === "recipe" && source.recipe ? (
              <p className="text-helper">
                <Link
                  href={recipePath(homeId, source.recipe.id)}
                  className="font-medium text-accent-fg underline"
                >
                  {t("openRecipe")}
                </Link>
              </p>
            ) : null}
          </form>
        )}
      </div>
    </Dialog>
  );
}

/** A meal as read-only facts: what is planned, its servings and notes, and its recipe's link. */
function MealFacts({
  source,
  homeId,
}: {
  readonly source: MealEntry | MealOccurrence | MealSeries | null;
  readonly homeId: string | null;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  if (!source) return null;
  return (
    <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_1fr]">
      <dt className="font-medium text-fg">{t("fieldMeal")}</dt>
      <dd className="text-fg">
        {source.type === "recipe" && source.recipe ? (
          <Link
            href={recipePath(homeId, source.recipe.id)}
            className="font-medium text-accent-fg underline"
          >
            <bdi>{source.recipe.name}</bdi>
          </Link>
        ) : (
          <bdi>{texts.mealTitle(source)}</bdi>
        )}
      </dd>
      {source.servings !== null ? (
        <>
          <dt className="font-medium text-fg">{t("fieldServings")}</dt>
          <dd className="text-fg">{source.servings}</dd>
        </>
      ) : null}
      {source.notes ? (
        <>
          <dt className="font-medium text-fg">{t("fieldNotes")}</dt>
          <dd className="whitespace-pre-line text-fg">{source.notes}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** What already fills the slot, with an explicit choice: keep it, or replace it. */
function OccupiedChoice({
  occupied,
  busy,
  error,
  onKeep,
  onReplace,
}: {
  readonly occupied: MealOccupied;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onKeep: () => void;
  readonly onReplace: () => void;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  return (
    <div className="flex flex-col gap-3" data-testid="meal-occupied">
      <FormAlert tone="info" announce>
        {t("occupiedExplanation")}
      </FormAlert>
      <ul className="flex flex-col gap-1 text-body text-fg">
        {occupied.occupants.map((occupant) => (
          <li key={mealKey(occupant)}>
            <bdi className="font-medium">{texts.mealTitle(occupant)}</bdi>
            {occupant.kind === "occurrence" ? (
              <span className="text-helper text-fg-muted">
                {" "}
                {"\u{00B7}"} {t("repeatingMark")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-helper text-fg-muted">{t("replaceExplanation")}</p>
      {error ? (
        <FormAlert tone="error" announce>
          {error}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onKeep} data-testid="meal-keep">
          {t("keepExisting")}
        </Button>
        <Button variant="destructive" loading={busy} onClick={onReplace} data-testid="meal-replace">
          {t("replaceExisting")}
        </Button>
      </div>
    </div>
  );
}

/**
 * A repeating meal's next dates and every day in the coming year where something is already
 * planned in its slot, each with a choice: skip the new meal that day, or replace what is there.
 */
export function CollisionChoice({
  preview,
  changed,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  readonly preview: MealSeriesPreview;
  readonly changed: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onConfirm: (decisions: Record<string, "skip" | "replace">) => void;
}) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const texts = useMealTexts();
  const [decisions, setDecisions] = useState<Record<string, "skip" | "replace">>(() =>
    Object.fromEntries(
      preview.collisions.map((collision: MealCollision) => [collision.date, "skip"]),
    ),
  );
  return (
    <div className="flex flex-col gap-3" data-testid="meal-collisions">
      {changed ? (
        <FormAlert tone="info" announce>
          {t("collisionsChanged")}
        </FormAlert>
      ) : null}
      {preview.nextDates.length > 0 ? (
        <p className="text-body text-fg">
          {t("nextDates", {
            dates: preview.nextDates
              .map((date) => formatMealDate(date, locale, "short"))
              .join(", "),
          })}
        </p>
      ) : (
        <p className="text-body text-fg">{t("noNextDates")}</p>
      )}
      {preview.collisions.length === 0 ? (
        <p className="text-helper text-fg-muted">{t("noCollisions")}</p>
      ) : (
        <>
          <p className="text-body text-fg">
            {t("collisionsExplanation", { count: preview.collisions.length })}
          </p>
          <ul className="flex max-h-64 flex-col gap-3 overflow-y-auto">
            {preview.collisions.map((collision) => (
              <li
                key={collision.date}
                className="flex flex-col gap-1 rounded-control border border-line p-3"
              >
                <span className="text-body font-medium text-fg">
                  {formatMealDate(collision.date, locale)}
                </span>
                <span className="text-helper text-fg-muted">
                  {t("collisionWith", {
                    meals: collision.occupants
                      .map((occupant) => texts.mealTitle(occupant))
                      .join(", "),
                  })}
                </span>
                <SelectField
                  label={t("collisionChoice")}
                  value={decisions[collision.date] ?? "skip"}
                  onChange={(event) => {
                    const choice = event.target.value === "replace" ? "replace" : "skip";
                    setDecisions((current) => ({ ...current, [collision.date]: choice }));
                  }}
                  options={[
                    { value: "skip", label: t("collisionSkip") },
                    { value: "replace", label: t("collisionReplace") },
                  ]}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {error ? (
        <FormAlert tone="error" announce>
          {error}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onBack}>
          {t("back")}
        </Button>
        <Button
          loading={busy}
          onClick={() => {
            onConfirm(decisions);
          }}
          data-testid="meal-series-confirm"
        >
          {t("saveRepeating")}
        </Button>
      </div>
    </div>
  );
}
