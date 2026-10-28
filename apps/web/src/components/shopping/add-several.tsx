"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import {
  parseShoppingLines,
  parseShoppingQuantity,
  SHOPPING_LIMITS,
  shoppingNameKey,
  shoppingUnits,
} from "@madeora/domain/shopping";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { ShoppingRequestError, type ShoppingAddOutcome } from "@/shopping/api";
import { quantityInput, shoppingKeys, shoppingListPath } from "@/shopping/format";
import { itemNameSchema, notesSchema, packagingSchema, unitSchema } from "@/shopping/schema";

import { useFieldMessage } from "./field-message";
import { addShoppingItems } from "./quick-add";
import { useShoppingFailure, useShoppingTexts } from "./use-shopping-texts";

const optional = <S extends z.ZodType<string, string>>(schema: S) =>
  z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(schema.nullable());

const rowSchema = z
  .strictObject({
    id: z.uuid(),
    original: z.string(),
    uncertain: z.boolean(),
    name: itemNameSchema,
    quantity: z.string().transform((value, context) => {
      if (value.trim() === "") return null;
      const quantity = parseShoppingQuantity(value);
      if (quantity === null) {
        context.addIssue({ code: "custom", message: "invalidQuantity" });
        return z.NEVER;
      }
      return quantity;
    }),
    unit: z.union([z.literal(""), unitSchema]).transform((value) => (value === "" ? null : value)),
    packaging: optional(packagingSchema),
    notes: optional(notesSchema),
    keepDuplicate: z.boolean(),
    /** The server said an active item has this name since the review. */
    serverDuplicate: z.boolean(),
  })
  .refine((row) => row.unit === null || row.quantity !== null, {
    error: "unitNeedsQuantity",
    path: ["unit"],
  });
const batchSchema = z.strictObject({ rows: z.array(rowSchema).max(SHOPPING_LIMITS.batch) });
type BatchInput = z.input<typeof batchSchema>;
type BatchOutput = z.output<typeof batchSchema>;
type RowInput = BatchInput["rows"][number];

/** A row field's form path ("rows.2.name"), typed as React Hook Form names it. */
function rowPath<K extends Extract<keyof RowInput, string>>(index: number, key: K) {
  return `rows.${String(index)}.${key}` as `rows.${number}.${K}`;
}

export interface AddSeveralProps {
  readonly listId: string;
  readonly homeId: string | null;
  /** Names of the list's active items, for duplicate marks (the server checks again). */
  readonly activeNames: readonly string[];
}

/**
 * Add several (S26): one item per line, blank lines ignored, at most 100. Review reads each line
 * into an editable row: a leading quantity and unit only when unambiguous, otherwise the whole
 * line as the name, flagged "Check this line" with the original shown. Duplicates (within the
 * batch, or of an active item) are marked: Keep as separate item or Remove row; nothing is merged.
 * Categories are never assigned. Add commits the rows in one request; each row has its own id, so
 * a retry after a partial failure never adds a row twice.
 */
export function AddSeveral({ listId, homeId, activeNames }: AddSeveralProps) {
  const t = useTranslations("Shopping");
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const failure = useShoppingFailure();
  const message = useFieldMessage();
  const texts = useShoppingTexts({ byId: new Map(), selfId: null });
  const { announce, region } = useAnnouncer();
  const [text, setText] = useState("");
  const [overflow, setOverflow] = useState(0);
  const [stage, setStage] = useState<"enter" | "review">("enter");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [rowProblems, setRowProblems] = useState<ReadonlyMap<string, ShoppingAddOutcome>>(
    new Map(),
  );
  const form = useForm<BatchInput, unknown, BatchOutput>({
    resolver: zodResolver(batchSchema),
    defaultValues: { rows: [] },
  });
  const rows = useFieldArray({ control: form.control, name: "rows" });
  const watched = useWatch({ control: form.control, name: "rows" });

  const existing = new Set(activeNames.map(shoppingNameKey));
  const duplicateOf = (index: number): "list" | "batch" | null => {
    const row = watched[index];
    if (!row) return null;
    const key = shoppingNameKey(row.name);
    if (key === "") return null;
    if (row.serverDuplicate || existing.has(key)) return "list";
    return watched.slice(0, index).some((other) => shoppingNameKey(other.name) === key)
      ? "batch"
      : null;
  };

  const review = () => {
    const parsed = parseShoppingLines(text);
    if (parsed.lines.length === 0) {
      setProblem(t("addSeveralEmpty"));
      return;
    }
    setProblem(null);
    setOverflow(parsed.overflow);
    setRowProblems(new Map());
    form.reset({
      rows: parsed.lines.map((line): RowInput => ({
        id: crypto.randomUUID(),
        original: line.original,
        uncertain: line.uncertain,
        name: line.name,
        quantity: quantityInput(line.quantity, locale),
        unit: line.unit ?? "",
        packaging: "",
        notes: "",
        keepDuplicate: false,
        serverDuplicate: false,
      })),
    });
    setStage("review");
  };

  const commit = async (values: BatchOutput) => {
    const unresolved = values.rows.findIndex(
      (row, index) => duplicateOf(index) !== null && !row.keepDuplicate,
    );
    if (unresolved >= 0) {
      setProblem(t("resolveDuplicates"));
      form.setFocus(rowPath(unresolved, "name"));
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const results = await addShoppingItems(
        listId,
        values.rows.map((row) => ({
          id: row.id,
          name: row.name,
          quantity: row.quantity,
          unit: row.unit,
          packaging: row.packaging,
          notes: row.notes,
          allowDuplicate: row.keepDuplicate,
        })),
      );
      const outcome = new Map(results.map((result) => [result.id, result.outcome]));
      const added = values.rows.filter((row) => {
        const answer = outcome.get(row.id);
        return answer === "created" || answer === "exists";
      });
      void queryClient.invalidateQueries({ queryKey: shoppingKeys.all });
      if (added.length === values.rows.length) {
        router.push(shoppingListPath(homeId, listId));
        router.refresh();
        return;
      }
      // Keep the rows that were not added, with what stopped each; the added ones are done.
      const remaining = form
        .getValues("rows")
        .filter((row) => !added.some((done) => done.id === row.id))
        .map((row) =>
          outcome.get(row.id) === "duplicate" ? { ...row, serverDuplicate: true } : row,
        );
      form.reset({ rows: remaining });
      setRowProblems(
        new Map(
          remaining.flatMap((row) => {
            const answer = outcome.get(row.id);
            return answer && answer !== "duplicate" ? [[row.id, answer] as const] : [];
          }),
        ),
      );
      announce(t("addSeveralPartial", { added: added.length, left: remaining.length }));
      setProblem(t("addSeveralPartial", { added: added.length, left: remaining.length }));
    } catch (error) {
      setProblem(
        failure(error instanceof ShoppingRequestError ? error.failure : "failed") +
          (error instanceof ShoppingRequestError && error.failure === "network"
            ? ` ${t("tryAgainHint")}`
            : ""),
      );
    } finally {
      setBusy(false);
    }
  };

  const rowProblemText = (outcome: ShoppingAddOutcome) =>
    outcome === "limit_reached"
      ? failure("limitReached")
      : outcome === "not_permitted"
        ? failure("notPermitted")
        : outcome === "not_found"
          ? failure("notFound")
          : failure("invalid");

  return (
    <HydrationGate>
      {region}
      {stage === "enter" ? (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
        >
          <TextArea
            label={t("addSeveralField")}
            description={t("addSeveralHint", { max: SHOPPING_LIMITS.batch })}
            rows={10}
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
            }}
            data-testid="shopping-add-several-text"
          />
          {problem ? (
            <FormAlert tone="error" announce>
              {problem}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" data-testid="shopping-add-several-review">
              {t("review")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                router.push(shoppingListPath(homeId, listId));
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void form.handleSubmit(commit)(event);
          }}
          data-testid="shopping-add-several-preview"
        >
          {overflow > 0 ? (
            <FormAlert tone="info" announce>
              {t("addSeveralOverflow", { count: overflow, max: SHOPPING_LIMITS.batch })}
            </FormAlert>
          ) : null}
          <ol className="flex flex-col gap-3">
            {rows.fields.map((field, index) => {
              const errors = form.formState.errors.rows?.[index];
              const duplicate = duplicateOf(index);
              const row = watched[index];
              const rowProblem = row?.id ? rowProblems.get(row.id) : undefined;
              return (
                <li
                  key={field.id}
                  className="flex flex-col gap-3 rounded-control border border-line p-3"
                  data-testid="shopping-preview-row"
                >
                  {row?.uncertain ? (
                    <p className="text-helper text-warning">
                      {t("checkThisLine")}{" "}
                      <span className="text-fg-muted">
                        {t("originalLine")} <bdi>{row.original}</bdi>
                      </span>
                    </p>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
                    <TextField
                      label={t("fieldName")}
                      autoComplete="off"
                      error={message(errors?.name?.message)}
                      {...form.register(rowPath(index, "name"))}
                    />
                    <TextField
                      label={t("fieldQuantity")}
                      inputMode="decimal"
                      autoComplete="off"
                      error={message(errors?.quantity?.message)}
                      {...form.register(rowPath(index, "quantity"))}
                    />
                    <SelectField
                      label={t("fieldUnit")}
                      options={[
                        { value: "", label: t("unitNone") },
                        ...shoppingUnits.map((unit) => ({ value: unit, label: texts.unit(unit) })),
                      ]}
                      {...form.register(rowPath(index, "unit"))}
                    />
                  </div>
                  {errors?.unit?.message ? (
                    <p className="text-helper text-danger">{message(errors.unit.message)}</p>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextField
                      label={t("fieldPackaging")}
                      autoComplete="off"
                      error={message(errors?.packaging?.message)}
                      {...form.register(rowPath(index, "packaging"))}
                    />
                    <TextField
                      label={t("fieldNotes")}
                      autoComplete="off"
                      error={message(errors?.notes?.message)}
                      {...form.register(rowPath(index, "notes"))}
                    />
                  </div>
                  {duplicate ? (
                    <div className="flex flex-col gap-2" data-testid="shopping-preview-duplicate">
                      <p className="text-helper text-warning">
                        {duplicate === "list" ? t("duplicateInList") : t("duplicateInBatch")}
                      </p>
                      <label className="flex items-center gap-2 text-body text-fg">
                        <input
                          type="checkbox"
                          className="size-4 accent-accent"
                          {...form.register(rowPath(index, "keepDuplicate"))}
                        />
                        {t("keepSeparate")}
                      </label>
                    </div>
                  ) : null}
                  {rowProblem ? (
                    <p className="text-helper text-danger">{rowProblemText(rowProblem)}</p>
                  ) : null}
                  <div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        rows.remove(index);
                      }}
                      aria-label={t("removeRowNamed", { name: row?.name ?? "" })}
                    >
                      {t("removeRow")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          {problem ? (
            <FormAlert tone="error" announce>
              {problem}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              loading={busy}
              disabled={rows.fields.length === 0}
              data-testid="shopping-add-several-commit"
            >
              {t("addCount", { count: rows.fields.length })}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setStage("enter");
                setProblem(null);
              }}
            >
              {t("backToText")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                router.push(shoppingListPath(homeId, listId));
              }}
            >
              {t("cancelBatch")}
            </Button>
          </div>
        </form>
      )}
    </HydrationGate>
  );
}
