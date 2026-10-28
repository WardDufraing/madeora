"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { isMealDate, weekStartOf, type MealWeekStart } from "@madeora/domain/meals";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { LoadingState } from "@/components/ui/states";
import {
  MEAL_COPY_ENDPOINT,
  sendMealRequest,
  type MealCopyPreview,
  type MealCopyResult,
  type MealCopyRow,
  type MealRequestError,
} from "@/meals/api";
import { formatMealDate, mealKeys, mealsPath, newId } from "@/meals/format";

import { useMealMutation } from "./use-meal-mutation";
import { useMealTexts } from "./use-meal-texts";

export interface MealCopyWeekProps {
  readonly homeId: string | null;
  /** First days of the source and the proposed destination week. */
  readonly source: string;
  readonly destination: string;
  readonly weekStart: MealWeekStart;
}

type Choice = "copy" | "skip" | "replace";

/**
 * Copy week (S27): the source week's meals mapped to the same weekday and slot of another week of
 * the same context, each row excludable. Unavailable recipes and disabled slots are not copyable;
 * an occupied destination needs a choice (skip or replace). Copies are single meals, never repeating
 * ones. The commit sends the preview's token: if the weeks changed meanwhile nothing is copied and
 * the preview is read again.
 */
export function MealCopyWeek({ homeId, source, destination, weekStart }: MealCopyWeekProps) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const texts = useMealTexts();
  const [weeks, setWeeks] = useState({ source, destination });
  const [fields, setFields] = useState({ source, destination });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [results, setResults] = useState<readonly MealCopyResult[] | null>(null);
  const [stale, setStale] = useState(false);
  // One client id per row and preview, so a retry never copies a meal twice.
  const [ids, setIds] = useState<Record<string, string>>({});
  const search = new URLSearchParams({ source: weeks.source, destination: weeks.destination });
  if (homeId) search.set("homeId", homeId);
  const preview = useQuery<{ preview: MealCopyPreview }, MealRequestError>({
    queryKey: [...mealKeys.all, "copy", homeId ?? "personal", weeks.source, weeks.destination],
    queryFn: () => sendMealRequest("GET", `${MEAL_COPY_ENDPOINT}?${search.toString()}`),
    retry: false,
  });
  const rows = preview.data?.preview.rows ?? [];
  const choiceOf = (row: MealCopyRow): Choice =>
    choices[row.key] ?? (row.status !== "ok" ? "skip" : row.occupants.length > 0 ? "skip" : "copy");
  const idOf = (row: MealCopyRow) => ids[row.key] ?? row.key;

  const copy = useMealMutation(
    "meal-copy-week",
    (token: string) => {
      const chosen = rows.filter((row) => row.status === "ok" && choiceOf(row) !== "skip");
      const assigned = { ...ids };
      for (const row of chosen) assigned[row.key] ??= newId();
      setIds(assigned);
      return sendMealRequest<{ results: readonly MealCopyResult[] }>("POST", MEAL_COPY_ENDPOINT, {
        homeId,
        source: weeks.source,
        destination: weeks.destination,
        token,
        rows: chosen.map((row) => ({
          key: row.key,
          id: assigned[row.key] ?? idOf(row),
          replace: choiceOf(row) === "replace",
        })),
      });
    },
    ({ results: answer }) => {
      setResults(answer);
    },
  );

  const chosenCount = rows.filter((row) => row.status === "ok" && choiceOf(row) !== "skip").length;

  return (
    <div className="flex flex-col gap-5" data-testid="meal-copy">
      <form
        noValidate
        className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isMealDate(fields.source) || !isMealDate(fields.destination)) return;
          setChoices({});
          setIds({});
          setResults(null);
          setStale(false);
          setWeeks({
            source: weekStartOf(fields.source, weekStart),
            destination: weekStartOf(fields.destination, weekStart),
          });
        }}
      >
        <TextField
          label={t("fieldSourceWeek")}
          description={t("fieldWeekHint")}
          type="date"
          value={fields.source}
          onChange={(event) => {
            setFields((current) => ({ ...current, source: event.target.value }));
          }}
        />
        <TextField
          label={t("fieldDestinationWeek")}
          description={t("fieldWeekHint")}
          type="date"
          value={fields.destination}
          onChange={(event) => {
            setFields((current) => ({ ...current, destination: event.target.value }));
          }}
          data-testid="meal-copy-destination"
        />
        <Button type="submit" variant="secondary">
          {t("showPreview")}
        </Button>
      </form>
      <p className="text-body text-fg">
        {t("copyFromTo", {
          source: formatMealDate(weeks.source, locale),
          destination: formatMealDate(weeks.destination, locale),
        })}
      </p>
      {preview.isPending ? (
        <LoadingState label={t("loading")} />
      ) : preview.error ? (
        <FormAlert tone="error" announce>
          {preview.error.failure === "invalid"
            ? t("copyWeeksInvalid")
            : texts.failure(preview.error.failure)}
        </FormAlert>
      ) : results ? (
        <CopyResults
          results={results}
          rows={rows}
          homeId={homeId}
          destination={weeks.destination}
        />
      ) : rows.length === 0 ? (
        <p className="text-body text-fg-muted">{t("copyNothing")}</p>
      ) : (
        <>
          {stale ? (
            <FormAlert tone="info" announce>
              {t("copyStale")}
            </FormAlert>
          ) : null}
          <ul className="flex flex-col gap-2" data-testid="meal-copy-rows">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-3"
              >
                <div className="flex flex-col">
                  <span className="text-body font-medium text-fg">
                    <bdi>{texts.mealTitle(row)}</bdi>
                  </span>
                  <span className="text-helper text-fg-muted">
                    {formatMealDate(row.date, locale, "short")}
                    {row.repeating ? ` \u{00B7} ${t("copyFromRepeating")}` : ""}
                  </span>
                  {row.status === "unavailable" ? (
                    <span className="text-helper text-fg-muted">{t("copyUnavailable")}</span>
                  ) : row.status === "slot_disabled" ? (
                    <span className="text-helper text-fg-muted">{t("copySlotDisabled")}</span>
                  ) : row.occupants.length > 0 ? (
                    <span className="text-helper text-warning">
                      {t("copyOccupied", {
                        meals: row.occupants
                          .map((occupant) => texts.mealTitle(occupant))
                          .join(", "),
                      })}
                    </span>
                  ) : null}
                </div>
                {row.status === "ok" ? (
                  <SelectField
                    label={t("copyChoice")}
                    value={choiceOf(row)}
                    onChange={(event) => {
                      const value = event.target.value;
                      const choice: Choice =
                        value === "replace" ? "replace" : value === "copy" ? "copy" : "skip";
                      setChoices((current) => ({ ...current, [row.key]: choice }));
                    }}
                    options={
                      row.occupants.length > 0
                        ? [
                            { value: "skip", label: t("copyKeepExisting") },
                            { value: "replace", label: t("copyReplace") },
                          ]
                        : [
                            { value: "copy", label: t("copyInclude") },
                            { value: "skip", label: t("copyExclude") },
                          ]
                    }
                    data-testid="meal-copy-choice"
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {copy.error && copy.error.failure !== "stale" ? (
            <FormAlert tone="error" announce>
              {texts.failure(copy.error.failure)}
            </FormAlert>
          ) : null}
          <div>
            <Button
              disabled={chosenCount === 0}
              loading={copy.busy}
              onClick={() => {
                copy.mutate(preview.data.preview.token, {
                  onError: (error) => {
                    if (error.failure === "stale") {
                      setStale(true);
                      setIds({});
                      void preview.refetch();
                    }
                  },
                });
              }}
              data-testid="meal-copy-confirm"
            >
              {t("copyConfirm", { count: chosenCount })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

const outcomeKey = {
  created: "copyOutcomeCreated",
  exists: "copyOutcomeCreated",
  id_taken: "copyOutcomeFailed",
  occupied: "copyOutcomeOccupied",
  unavailable: "copyOutcomeUnavailable",
  slot_unavailable: "copyOutcomeSlotUnavailable",
  missing: "copyOutcomeMissing",
} as const satisfies Record<MealCopyResult["outcome"], string>;

function CopyResults({
  results,
  rows,
  homeId,
  destination,
}: {
  readonly results: readonly MealCopyResult[];
  readonly rows: readonly MealCopyRow[];
  readonly homeId: string | null;
  readonly destination: string;
}) {
  const t = useTranslations("Meals");
  const texts = useMealTexts();
  const copied = results.filter(
    (result) => result.outcome === "created" || result.outcome === "exists",
  );
  const skipped = results.filter((result) => !copied.includes(result));
  return (
    <div className="flex flex-col gap-3" data-testid="meal-copy-results">
      <FormAlert tone="success" announce>
        {t("copyDone", { count: copied.length })}
      </FormAlert>
      {skipped.length > 0 ? (
        <>
          <p className="text-body text-fg">{t("copyNotCopied")}</p>
          <ul className="list-disc ps-5 text-body text-fg">
            {skipped.map((result) => {
              const row = rows.find((candidate) => candidate.key === result.key);
              return (
                <li key={result.key}>
                  <bdi>{row ? texts.mealTitle(row) : result.key}</bdi>
                  {" \u{2014} "}
                  {t(outcomeKey[result.outcome])}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <p>
        <Link
          href={`${mealsPath(homeId)}?date=${destination}`}
          className="font-medium text-accent-fg underline"
        >
          {t("openDestinationWeek")}
        </Link>
      </p>
    </div>
  );
}
