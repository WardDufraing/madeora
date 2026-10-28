"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { useFieldArray, useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { z } from "zod";

import { buildTransferRows, isMealDate, type TransferMealRows } from "@madeora/domain/meals";
import { parseShoppingQuantity, shoppingUnits } from "@madeora/domain/shopping";

import { FormAlert } from "@/components/auth/form-alert";
import { useUnitLabel } from "@/components/recipes/scaled-ingredients";
import { useFieldMessage } from "@/components/shopping/field-message";
import { useShoppingTexts } from "@/components/shopping/use-shopping-texts";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { LoadingState } from "@/components/ui/states";
import { TextField } from "@/components/ui/text-field";
import {
  MEAL_TRANSFER_ENDPOINT,
  sendMealRequest,
  type MealRequestError,
  type MealTransferPreview,
  type MealTransferResult,
} from "@/meals/api";
import { formatMealDate, mealKeys, newId } from "@/meals/format";
import { MEAL_TRANSFER_MAX_ROWS } from "@/meals/schema";
import { shoppingListPath, shoppingPath } from "@/shopping/format";
import { itemNameSchema, notesSchema, packagingSchema, unitSchema } from "@/shopping/schema";
import { noMembers } from "@/tasks/format";

import { useMealMutation } from "./use-meal-mutation";
import { useMealTexts } from "./use-meal-texts";

export interface MealShoppingTransferProps {
  readonly homeId: string | null;
  /** The range proposed first: the week the planner showed. */
  readonly from: string;
  readonly to: string;
}

const optional = <S extends z.ZodType<string, string>>(schema: S) =>
  z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(schema.nullable());

const rowForm = z
  .object({
    key: z.string(),
    id: z.uuid(),
    include: z.boolean(),
    name: z.string(),
    quantity: z.string(),
    unit: z.union([z.literal(""), unitSchema]),
    packaging: z.string(),
    notes: z.string(),
  })
  .superRefine((row, context) => {
    if (!row.include) return;
    const name = itemNameSchema.safeParse(row.name);
    if (!name.success) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: name.error.issues[0]?.message ?? "invalid",
      });
    }
    if (row.quantity.trim() !== "" && parseShoppingQuantity(row.quantity) === null) {
      context.addIssue({ code: "custom", path: ["quantity"], message: "invalidQuantity" });
    }
    if (row.unit !== "" && row.quantity.trim() === "") {
      context.addIssue({ code: "custom", path: ["unit"], message: "unitNeedsQuantity" });
    }
    if (!optional(packagingSchema).safeParse(row.packaging).success) {
      context.addIssue({ code: "custom", path: ["packaging"], message: "tooLong" });
    }
    if (!optional(notesSchema).safeParse(row.notes).success) {
      context.addIssue({ code: "custom", path: ["notes"], message: "tooLong" });
    }
  });
const transferForm = z.object({ listId: z.string().min(1, "required"), rows: z.array(rowForm) });
type TransferValues = z.infer<typeof transferForm>;

/** A reviewed row as the shopping API takes it. */
function toItem(row: TransferValues["rows"][number], allowDuplicate: boolean) {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity.trim() === "" ? null : parseShoppingQuantity(row.quantity),
    unit: row.unit === "" ? null : row.unit,
    packaging: row.packaging.trim() === "" ? null : row.packaging,
    notes: row.notes.trim() === "" ? null : row.notes,
    categoryId: null,
    allowDuplicate,
  };
}

/**
 * Add a date range's ingredients to a shopping list (S27; never automatic). The preview lists each
 * planned meal of the range once: recipe meals give one editable row per ingredient (scaled to the
 * meal's servings when the recipe states its yield, otherwise "Not scaled"; never merged), custom
 * meals and unavailable recipes give none. The destination is a list of the same context the person
 * may add to. Rows go in as ordinary shopping items with their own ids, so a retry never adds twice;
 * a row whose name is already on the list is reported and only added again when the person says so.
 */
export function MealShoppingTransfer({ homeId, from, to }: MealShoppingTransferProps) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const [range, setRange] = useState({ from, to });
  const [fields, setFields] = useState({ from, to });
  const search = new URLSearchParams({ from: range.from, to: range.to });
  if (homeId) search.set("homeId", homeId);
  const preview = useQuery<{ preview: MealTransferPreview }, MealRequestError>({
    queryKey: [...mealKeys.all, "transfer", homeId ?? "personal", range.from, range.to],
    queryFn: () => sendMealRequest("GET", `${MEAL_TRANSFER_ENDPOINT}?${search.toString()}`),
    retry: false,
    // A review in progress is not replaced under the person's hands.
    refetchOnWindowFocus: false,
  });
  const texts = useMealTexts();
  return (
    <div className="flex flex-col gap-5" data-testid="meal-transfer">
      <form
        noValidate
        className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (isMealDate(fields.from) && isMealDate(fields.to)) setRange(fields);
        }}
      >
        <TextField
          label={t("fieldFrom")}
          type="date"
          value={fields.from}
          onChange={(event) => {
            setFields((current) => ({ ...current, from: event.target.value }));
          }}
          data-testid="meal-transfer-from"
        />
        <TextField
          label={t("fieldTo")}
          description={t("fieldToHint")}
          type="date"
          value={fields.to}
          onChange={(event) => {
            setFields((current) => ({ ...current, to: event.target.value }));
          }}
          data-testid="meal-transfer-to"
        />
        <Button type="submit" variant="secondary">
          {t("showPreview")}
        </Button>
      </form>
      <p className="text-body text-fg">
        {t("transferRange", {
          from: formatMealDate(range.from, locale),
          to: formatMealDate(range.to, locale),
        })}
      </p>
      {preview.isPending ? (
        <LoadingState label={t("loading")} />
      ) : preview.error ? (
        <FormAlert tone="error" announce>
          {preview.error.failure === "invalid"
            ? t("transferRangeInvalid")
            : texts.failure(preview.error.failure)}
        </FormAlert>
      ) : (
        <TransferReview
          key={preview.data.preview.token}
          homeId={homeId}
          range={range}
          preview={preview.data.preview}
          onStale={() => {
            void preview.refetch();
          }}
        />
      )}
    </div>
  );
}

function TransferReview({
  homeId,
  range,
  preview,
  onStale,
}: {
  readonly homeId: string | null;
  readonly range: { readonly from: string; readonly to: string };
  readonly preview: MealTransferPreview;
  readonly onStale: () => void;
}) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  const texts = useMealTexts();
  const unitLabel = useUnitLabel();
  const meals = buildTransferRows(preview.meals);
  const excluded = preview.meals.filter((meal) => meal.status !== "included");
  const [transferId] = useState(newId);
  const [results, setResults] = useState<readonly MealTransferResult[] | null>(null);
  const [stale, setStale] = useState(false);
  const form = useForm<TransferValues>({
    resolver: zodResolver(transferForm),
    defaultValues: {
      listId: preview.lists.length === 1 ? (preview.lists[0]?.id ?? "") : "",
      rows: meals.flatMap(({ rows }) =>
        rows.map((row) => ({
          key: row.key,
          id: newId(),
          include: true,
          name: row.name,
          quantity:
            row.quantity === null ? "" : row.quantity.replace(".", decimalSeparator(locale)),
          unit: row.unit ?? "",
          packaging: row.packagingUnit ? unitLabel(row.packagingUnit, null) : "",
          notes: row.notes ?? "",
        })),
      ),
    },
  });
  const array = useFieldArray({ control: form.control, name: "rows", keyName: "fieldKey" });
  const watchedRows = useWatch({ control: form.control, name: "rows" });
  const send = useMealMutation(
    `meal-transfer:${transferId}`,
    ({ values, duplicates }: { values: TransferValues; duplicates: ReadonlySet<string> | null }) =>
      sendMealRequest<{ results: readonly MealTransferResult[] }>("POST", MEAL_TRANSFER_ENDPOINT, {
        id: transferId,
        homeId,
        from: range.from,
        to: range.to,
        listId: values.listId,
        token: preview.token,
        items: values.rows
          .filter((row) => row.include && (duplicates === null || duplicates.has(row.id)))
          .map((row) => toItem(row, duplicates !== null)),
      }),
    ({ results: answer }) => {
      setResults((current) => {
        // A second round (duplicates added anyway) updates those rows only.
        if (!current) return answer;
        const next = new Map(current.map((result) => [result.id, result]));
        for (const result of answer) next.set(result.id, result);
        return [...next.values()];
      });
    },
  );

  if (preview.lists.length === 0) {
    return (
      <FormAlert tone="info">
        {t("transferNoList")}{" "}
        <Link href={shoppingPath(homeId)} className="font-medium text-accent-fg underline">
          {t("openShopping")}
        </Link>
      </FormAlert>
    );
  }
  if (meals.length === 0) {
    return (
      <>
        <p className="text-body text-fg-muted">{t("transferNothing")}</p>
        <ExcludedMeals meals={excluded} />
      </>
    );
  }

  const values = form.getValues();
  const included = watchedRows.filter((row) => row.include).length;

  if (results) {
    const byId = new Map(results.map((result) => [result.id, result.outcome]));
    const added = results.filter(
      (result) => result.outcome === "created" || result.outcome === "exists",
    );
    const duplicates = values.rows.filter((row) => byId.get(row.id) === "duplicate");
    const failed = results.length - added.length - duplicates.length;
    const listName = preview.lists.find((list) => list.id === values.listId)?.name ?? "";
    return (
      <div className="flex flex-col gap-3" data-testid="meal-transfer-results">
        <FormAlert tone="success" announce>
          {t("transferDone", { count: added.length, list: listName })}
        </FormAlert>
        {duplicates.length > 0 ? (
          <DuplicateRows
            names={duplicates.map((row) => ({ id: row.id, name: row.name }))}
            busy={send.busy}
            onAdd={(ids) => {
              send.mutate({ values, duplicates: ids });
            }}
          />
        ) : null}
        {failed > 0 ? (
          <FormAlert tone="error">{t("transferSomeFailed", { count: failed })}</FormAlert>
        ) : null}
        <p>
          <Link
            href={shoppingListPath(homeId, values.listId)}
            className="font-medium text-accent-fg underline"
            data-testid="meal-transfer-open-list"
          >
            {t("openList", { list: listName })}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        void form.handleSubmit((submitted) => {
          send.mutate(
            { values: submitted, duplicates: null },
            {
              onError: (error) => {
                if (error.failure === "stale") {
                  setStale(true);
                  onStale();
                }
              },
            },
          );
        })(event);
      }}
    >
      {stale ? (
        <FormAlert tone="info" announce>
          {t("transferStale")}
        </FormAlert>
      ) : null}
      {meals.map((group) => (
        <MealRows
          key={group.meal.key}
          group={group}
          form={form}
          indexOf={(key) => array.fields.findIndex((field) => field.key === key)}
          locale={locale}
        />
      ))}
      <ExcludedMeals meals={excluded} />
      <SelectField
        label={t("fieldList")}
        error={texts.field(form.formState.errors.listId?.message)}
        options={[
          ...(preview.lists.length === 1 ? [] : [{ value: "", label: t("listChoose") }]),
          ...preview.lists.map((list) => ({ value: list.id, label: list.name })),
        ]}
        data-testid="meal-transfer-list"
        {...form.register("listId")}
      />
      {included > MEAL_TRANSFER_MAX_ROWS ? (
        <FormAlert tone="error" announce>
          {t("transferTooMany", { max: MEAL_TRANSFER_MAX_ROWS })}
        </FormAlert>
      ) : null}
      {send.error && send.error.failure !== "stale" ? (
        <FormAlert tone="error" announce>
          {texts.failure(send.error.failure)}
        </FormAlert>
      ) : null}
      <div>
        <Button
          type="submit"
          disabled={included === 0 || included > MEAL_TRANSFER_MAX_ROWS}
          loading={send.busy}
          data-testid="meal-transfer-confirm"
        >
          {t("transferConfirm", { count: included })}
        </Button>
      </div>
    </form>
  );
}

type RowField = keyof TransferValues["rows"][number];

/** A row field's form path ("rows.2.name"), typed as React Hook Form names it. */
function rowPath<K extends RowField>(index: number, key: K): `rows.${number}.${K}` {
  return `rows.${String(index)}.${key}` as `rows.${number}.${K}`;
}

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
      ?.value ?? "."
  );
}

/** One meal's ingredient rows, each editable or left out. */
function MealRows({
  group,
  form,
  indexOf,
  locale,
}: {
  readonly group: TransferMealRows;
  readonly form: UseFormReturn<TransferValues>;
  readonly indexOf: (key: string) => number;
  readonly locale: string;
}) {
  const t = useTranslations("Meals");
  const message = useFieldMessage();
  const shopping = useShoppingTexts(noMembers);
  const texts = useMealTexts();
  const errors = form.formState.errors.rows;
  const watched = useWatch({ control: form.control, name: "rows" });
  return (
    <fieldset className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <legend className="px-1 text-body font-semibold text-fg">
        <bdi>
          {group.meal.recipe?.name ??
            texts.mealTitle({ type: "recipe", recipe: null, title: null })}
        </bdi>
        <span className="font-normal text-fg-muted">
          {" \u{00B7} "}
          {formatMealDate(group.meal.date, locale, "short")}
          {" \u{00B7} "}
          {group.scaled ? t("scaledTo", { count: group.meal.servings ?? 0 }) : t("notScaled")}
        </span>
      </legend>
      {group.rows.length === 0 ? (
        <p className="text-helper text-fg-muted">{t("noIngredients")}</p>
      ) : null}
      {group.rows.map((row) => {
        const index = indexOf(row.key);
        if (index < 0) return null;
        const rowErrors = errors?.[index];
        const include = watched[index]?.include ?? true;
        return (
          <div
            key={row.key}
            className="flex flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0"
            data-testid="meal-transfer-row"
          >
            <label className="flex items-center gap-2 text-body font-medium text-fg">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                {...form.register(rowPath(index, "include"))}
              />
              <bdi>{row.name}</bdi>
            </label>
            {row.approximate ? (
              <p className="text-helper text-fg-muted">{t("approximate")}</p>
            ) : null}
            {row.quantityDropped ? (
              <p className="text-helper text-warning">{t("quantityDropped")}</p>
            ) : null}
            {row.packagingUnit ? (
              <p className="text-helper text-fg-muted">{t("unitAsPackaging")}</p>
            ) : null}
            {include ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <TextField
                  label={t("fieldItemName")}
                  className="lg:col-span-2"
                  autoComplete="off"
                  error={message(rowErrors?.name?.message)}
                  {...form.register(rowPath(index, "name"))}
                />
                <TextField
                  label={t("fieldQuantity")}
                  inputMode="decimal"
                  autoComplete="off"
                  error={message(rowErrors?.quantity?.message)}
                  {...form.register(rowPath(index, "quantity"))}
                />
                <SelectField
                  label={t("fieldUnit")}
                  error={message(rowErrors?.unit?.message)}
                  options={[
                    { value: "", label: t("unitNone") },
                    ...shoppingUnits.map((unit) => ({ value: unit, label: shopping.unit(unit) })),
                  ]}
                  {...form.register(rowPath(index, "unit"))}
                />
                <TextField
                  label={t("fieldPackaging")}
                  autoComplete="off"
                  error={message(rowErrors?.packaging?.message)}
                  {...form.register(rowPath(index, "packaging"))}
                />
                <TextField
                  label={t("fieldItemNotes")}
                  className="sm:col-span-2 lg:col-span-5"
                  autoComplete="off"
                  error={message(rowErrors?.notes?.message)}
                  {...form.register(rowPath(index, "notes"))}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

function ExcludedMeals({ meals }: { readonly meals: MealTransferPreview["meals"] }) {
  const t = useTranslations("Meals");
  const locale = useLocale();
  if (meals.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" aria-labelledby="meal-transfer-excluded">
      <h2 id="meal-transfer-excluded" className="text-body font-semibold text-fg">
        {t("transferExcluded")}
      </h2>
      <ul className="list-disc ps-5 text-helper text-fg-muted">
        {meals.map((meal) => (
          <li key={meal.key}>
            {meal.status === "custom" ? (
              <>
                <bdi>{meal.title}</bdi> {"\u{00B7}"} {t("excludedCustom")}
              </>
            ) : (
              t("excludedUnavailable")
            )}{" "}
            {"\u{00B7}"} {formatMealDate(meal.date, locale, "short")}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DuplicateRows({
  names,
  busy,
  onAdd,
}: {
  readonly names: readonly { readonly id: string; readonly name: string }[];
  readonly busy: boolean;
  readonly onAdd: (ids: ReadonlySet<string>) => void;
}) {
  const t = useTranslations("Meals");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="flex flex-col gap-2" data-testid="meal-transfer-duplicates">
      <p className="text-body text-fg">{t("transferDuplicates")}</p>
      <ul className="flex flex-col gap-1">
        {names.map((row) => (
          <li key={row.id}>
            <label className="flex items-center gap-2 text-body text-fg">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={chosen.has(row.id)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(row.id);
                  else next.delete(row.id);
                  setChosen(next);
                }}
              />
              <bdi>{row.name}</bdi>
            </label>
          </li>
        ))}
      </ul>
      <div>
        <Button
          variant="secondary"
          disabled={chosen.size === 0}
          loading={busy}
          onClick={() => {
            onAdd(chosen);
          }}
        >
          {t("addAnyway", { count: chosen.size })}
        </Button>
      </div>
    </div>
  );
}
