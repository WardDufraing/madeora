"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { addDays, isMealDate } from "@madeora/domain/meals";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import {
  mealSeriesEndpoint,
  sendMealRequest,
  type MealPlan,
  type MealSeries,
  type MealSeriesPreview,
} from "@/meals/api";
import { formatMealDate } from "@/meals/format";

import { CollisionChoice } from "./meal-dialog";
import { useMealMutation } from "./use-meal-mutation";
import { useMealTexts } from "./use-meal-texts";

export interface MealSeriesListProps {
  readonly plan: MealPlan;
  readonly homeId: string | null;
  readonly onEdit: (series: MealSeries) => void;
}

/**
 * The context's repeating meals (S27): what repeats, when, in which slot, and whether it is paused
 * or its slot is disabled. People who may edit the plan change one from a date on, pause it, resume
 * it from a date (seeing what it would collide with first) or end it.
 */
export function MealSeriesList({ plan, homeId, onEdit }: MealSeriesListProps) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const texts = useMealTexts();
  const [action, setAction] = useState<{ series: MealSeries; kind: "resume" | "end" } | null>(null);
  const editable = plan.access !== "view";
  const toast = useToast();
  const pause = useMealMutation(
    "meal-series-pause",
    (series: MealSeries) =>
      sendMealRequest("PATCH", mealSeriesEndpoint(series.id), {
        action: "pause",
        revision: series.revision,
      }),
    () => {
      toast.show({ title: t("repeatingPaused"), tone: "success" });
    },
  );
  return (
    <section aria-labelledby="meal-series-heading" className="flex flex-col gap-3">
      <h2 id="meal-series-heading" className="text-section-title font-semibold">
        {t("repeatingTitle")}
      </h2>
      {plan.series.length === 0 ? (
        <p className="text-body text-fg-muted">{t("repeatingNone")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="meal-series-list">
          {plan.series.map((series) => (
            <li
              key={series.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-3"
            >
              <div className="flex flex-col">
                <span className="text-body font-medium text-fg">
                  <bdi>{texts.mealTitle(series)}</bdi>
                </span>
                <span className="text-helper text-fg-muted">
                  {texts.slotName(plan.slots.find((slot) => slot.id === series.slotId))}
                  {" \u{00B7} "}
                  {texts.schedule(series, locale)}
                  {series.endOn
                    ? ` \u{00B7} ${t("until", { date: formatMealDate(series.endOn, locale, "short") })}`
                    : ""}
                </span>
                {series.status === "paused" ? (
                  <span className="text-helper font-medium text-fg">{t("pausedMark")}</span>
                ) : null}
                {!series.slotEnabled ? (
                  <span className="text-helper font-medium text-warning">
                    {t("seriesSlotDisabled")}
                  </span>
                ) : null}
              </div>
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  {series.status === "active" ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onEdit(series);
                        }}
                      >
                        {t("editFuture")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={pause.busy && pause.variables?.id === series.id}
                        onClick={() => {
                          pause.mutate(series);
                        }}
                      >
                        {t("pause")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setAction({ series, kind: "resume" });
                      }}
                    >
                      {t("resume")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setAction({ series, kind: "end" });
                    }}
                  >
                    {t("end")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {pause.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(pause.error.failure)}
        </FormAlert>
      ) : null}
      {action ? (
        <SeriesDateDialog
          key={`${action.kind}:${action.series.id}`}
          series={action.series}
          kind={action.kind}
          today={plan.today}
          homeId={homeId}
          onClose={() => {
            setAction(null);
          }}
        />
      ) : null}
    </section>
  );
}

/** Resume from a date (after previewing collisions) or end from a date. */
function SeriesDateDialog({
  series,
  kind,
  today,
  homeId,
  onClose,
}: {
  readonly series: MealSeries;
  readonly kind: "resume" | "end";
  readonly today: string;
  readonly homeId: string | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const toast = useToast();
  const [from, setFrom] = useState(kind === "resume" ? addDays(today, 1) : today);
  const [preview, setPreview] = useState<{ value: MealSeriesPreview; changed: boolean } | null>(
    null,
  );
  const endpoint = mealSeriesEndpoint(series.id);
  const check = useMealMutation(`meal-series:${series.id}`, (changed: boolean) =>
    sendMealRequest<{ preview: MealSeriesPreview }>("PATCH", endpoint, {
      action: "preview",
      homeId,
      from,
      slotId: series.slotId,
      cadence: series.cadence,
      weekdays: series.weekdays,
      endOn: series.endOn,
    }).then(({ preview: value }) => {
      setPreview({ value, changed });
    }),
  );
  const save = useMealMutation(
    `meal-series:${series.id}`,
    (decisions: Record<string, "skip" | "replace">) =>
      sendMealRequest(
        "PATCH",
        endpoint,
        kind === "end"
          ? { action: "end", revision: series.revision, from }
          : {
              action: "resume",
              revision: series.revision,
              from,
              token: preview?.value.token ?? "",
              decisions,
            },
      ),
    () => {
      onClose();
      toast.show({
        title: kind === "end" ? t("repeatingEnded") : t("repeatingResumed"),
        tone: "success",
      });
    },
  );
  const error = save.error ?? check.error;
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === "end" ? t("endTitle") : t("resumeTitle")}
      description={texts.mealTitle(series)}
      closeLabel={t("close")}
    >
      {preview && kind === "resume" ? (
        <CollisionChoice
          key={preview.value.token}
          preview={preview.value}
          changed={preview.changed}
          busy={save.busy || check.busy}
          error={error && error.failure !== "conflicts" ? texts.failure(error.failure) : null}
          onBack={() => {
            setPreview(null);
          }}
          onConfirm={(decisions) => {
            save.mutate(decisions, {
              onError: (failure) => {
                if (failure.failure === "conflicts") check.mutate(true);
              },
            });
          }}
        />
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isMealDate(from)) return;
            if (kind === "end") save.mutate({});
            else check.mutate(false);
          }}
        >
          <TextField
            label={kind === "end" ? t("fieldEndFrom") : t("fieldResumeFrom")}
            description={kind === "end" ? t("fieldEndFromHint") : t("fieldResumeFromHint")}
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
            error={isMealDate(from) ? undefined : texts.field("invalid")}
            data-testid="meal-series-date"
          />
          {error ? (
            <FormAlert tone="error" announce>
              {texts.failure(error.failure)}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              variant={kind === "end" ? "destructive" : "primary"}
              loading={save.busy || check.busy}
              data-testid="meal-series-date-confirm"
            >
              {kind === "end" ? t("end") : t("continue")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
