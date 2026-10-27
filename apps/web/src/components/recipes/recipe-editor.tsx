"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch, type FieldPath } from "react-hook-form";

import { recipeUnits } from "@madeora/domain/recipes";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  RECIPES_ENDPOINT,
  recipeEndpoint,
  RecipeRequestError,
  sendRecipeRequest,
  type RecipeFailure,
  type SavedRecipe,
} from "@/recipes/api";
import { draftPath, recipePath } from "@/recipes/format";
import {
  emptyIngredient,
  RECIPE_FIELD_LIMITS,
  toRecipeContent,
  type RecipeContent,
  type RecipeFieldError,
  type RecipeFormValues,
} from "@/recipes/schema";

import { CoverField } from "./cover-field";
import { useUnitLabel } from "./scaled-ingredients";
import { TagsField } from "./tags-field";
import { useRecipeFailure } from "./use-recipe-texts";

const fieldErrorKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  invalidQuantity: "fieldInvalidQuantity",
  invalidNumber: "fieldInvalidNumber",
  duplicateTag: "tagDuplicate",
  tooMany: "fieldTooMany",
  invalid: "fieldInvalid",
} as const satisfies Record<RecipeFieldError, string>;

export interface HomeOption {
  readonly id: string;
  readonly name: string;
}

interface EditorBase {
  readonly recipeId: string;
  readonly initial: RecipeFormValues;
  /** The Homes the person belongs to now: where a recipe may be published. */
  readonly homes: readonly HomeOption[];
}

export type RecipeEditorProps = EditorBase &
  (
    | {
        /** A new recipe; `homeId` is the context it was started from (the default destination). */
        readonly mode: "new";
        readonly homeId: string | null;
      }
    | {
        /** The person's own draft, with its intended destination (null: Personal). */
        readonly mode: "draft";
        readonly revision: number;
        readonly destination: string | null;
      }
    | {
        /** A published recipe, edited under the lock whose token this is. */
        readonly mode: "published";
        readonly homeId: string | null;
        readonly revision: number;
        readonly lockToken: string;
        /** The lock is gone (refused save): the page shows the lapsed state. */
        readonly onLockLost: () => void;
        /** A save refused because the recipe changed since it was opened. */
        readonly onConflict: () => void;
        readonly onCancel: () => void;
        /** Disables saving while the lock is not held. */
        readonly locked: boolean;
      }
  );

/** Where the person picked for the recipe: `""` is the Personal space. */
type Destination = string;

/**
 * The recipe editor (S24): name, servings and their label, times, ingredients (quantity, unit,
 * note) and steps with Move up/down and Remove, tags, notes and the cover. A new recipe or a
 * draft is saved privately (only its creator ever sees a draft) or published after a confirmation
 * that names its audience; a published recipe is saved under its editing lock. Blank rows are
 * dropped; the database checks everything again.
 */
export function RecipeEditor(props: RecipeEditorProps) {
  const t = useTranslations("Recipes");
  const router = useRouter();
  const hydrated = useHydrated();
  const failureText = useRecipeFailure();
  const unitLabel = useUnitLabel();
  const form = useForm<RecipeFormValues>({ defaultValues: props.initial });
  const ingredients = useFieldArray({ control: form.control, name: "ingredients" });
  const steps = useFieldArray({ control: form.control, name: "steps" });
  const errors = form.formState.errors;
  const [revision, setRevision] = useState(props.mode === "new" ? null : props.revision);
  const [destination, setDestination] = useState<Destination>(
    props.mode === "new"
      ? (props.homeId ?? "")
      : props.mode === "draft"
        ? (props.destination ?? "")
        : "",
  );
  const [savedCover, setSavedCover] = useState(props.initial.coverFileId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RecipeFailure | null>(null);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState<RecipeContent | null>(null);
  const [publishRequest] = useState(() => crypto.randomUUID());
  const created = useRef(props.mode !== "new");
  const alertRef = useRef<HTMLDivElement>(null);

  const dirty = form.formState.isDirty;
  // A published recipe's unsaved changes are also kept in this tab's session storage, so a lapsed
  // lock, a conflict or a reload never loses them. They are offered back for review; changes made
  // to an older revision say so, because restoring them replaces what someone else saved.
  const backupKey = `madeora:recipe-edit:${props.recipeId}`;
  const [backup, setBackup] = useState<Backup | null>(null);
  const backupRevision = props.mode === "published" ? props.revision : null;
  useEffect(() => {
    if (backupRevision === null) return;
    const stored = readBackup(backupKey);
    // Offering a restore depends on this tab's storage, known only after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setBackup(stored);
  }, [backupKey, backupRevision]);
  const watched = useWatch({ control: form.control });
  useEffect(() => {
    if (backupRevision !== null && dirty) {
      writeBackup(backupKey, backupRevision, form.getValues());
    }
  }, [backupKey, backupRevision, dirty, form, watched]);
  // Leaving with unsaved changes asks first (the browser's own prompt).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);

  const message = (error: { readonly message?: string | undefined } | undefined) => {
    const key = error?.message as RecipeFieldError | undefined;
    return key && key in fieldErrorKey ? t(fieldErrorKey[key]) : undefined;
  };

  /** The form's content, or null after marking the wrong fields (focusing the first). */
  function content(forPublishing: boolean): RecipeContent | null {
    form.clearErrors();
    const result = toRecipeContent(form.getValues(), forPublishing);
    if (result.ok) return result.content;
    const entries = Object.entries(result.errors);
    for (const [path, code] of entries) {
      const field = (path === "root" ? "name" : path) as FieldPath<RecipeFormValues>;
      form.setError(field, { message: code });
    }
    const first = entries[0]?.[0];
    if (first && first !== "ingredients" && first !== "root") {
      form.setFocus(first as FieldPath<RecipeFormValues>);
    } else {
      setFailure(first === "ingredients" ? "incomplete" : "invalid");
    }
    return null;
  }

  function fail(error: unknown) {
    const refused = error instanceof RecipeRequestError ? error : new RecipeRequestError("failed");
    if (props.mode === "published") {
      if (refused.failure === "lockLost") props.onLockLost();
      if (refused.failure === "conflict") props.onConflict();
    }
    setFailure(refused.failure);
    window.setTimeout(() => alertRef.current?.focus(), 0);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    setSaved(false);
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  /** Saves privately: creates the draft once, then saves it by revision. */
  async function saveDraft(body: RecipeContent): Promise<number> {
    const homeId = destination === "" ? null : destination;
    if (!created.current) {
      const answer = await sendRecipeRequest<SavedRecipe>("POST", RECIPES_ENDPOINT, {
        id: props.recipeId,
        homeId,
        publish: false,
        content: body,
      });
      created.current = true;
      return answer.revision;
    }
    const answer = await sendRecipeRequest<SavedRecipe>("PATCH", recipeEndpoint(props.recipeId), {
      revision,
      content: body,
      lockToken: null,
      draftHomeId: homeId,
    });
    return answer.revision;
  }

  function onSaveDraft() {
    const body = content(false);
    if (!body) return;
    void run(async () => {
      const next = await saveDraft(body);
      setRevision(next);
      setSavedCover(body.coverFileId);
      form.reset(form.getValues());
      setSaved(true);
      // A new draft gets its own address without remounting, so the confirmation stays.
      if (props.mode === "new") window.history.replaceState(null, "", draftPath(props.recipeId));
      else router.refresh();
    });
  }

  function onPublish() {
    const body = content(true);
    if (body) setPublishing(body);
  }

  function confirmPublish() {
    const body = publishing;
    if (!body) return;
    const homeId = destination === "" ? null : destination;
    void run(async () => {
      if (props.mode === "new" && !created.current) {
        // Published at once: one request, retried safely by its id.
        await sendRecipeRequest<SavedRecipe>("POST", RECIPES_ENDPOINT, {
          id: props.recipeId,
          homeId,
          publish: true,
          content: body,
        });
      } else {
        // A draft: save what is on screen, then publish that revision.
        const current = await saveDraft(body);
        setRevision(current);
        form.reset(form.getValues());
        await sendRecipeRequest<SavedRecipe>("POST", recipeEndpoint(props.recipeId, "publish"), {
          revision: current,
          requestId: publishRequest,
          homeId,
        });
      }
      setPublishing(null);
      router.push(recipePath(homeId, props.recipeId));
    });
  }

  function onSavePublished() {
    if (props.mode !== "published") return;
    const body = content(true);
    if (!body) return;
    void run(async () => {
      await sendRecipeRequest<SavedRecipe>("PATCH", recipeEndpoint(props.recipeId), {
        revision,
        content: body,
        lockToken: props.lockToken,
        draftHomeId: null,
      });
      form.reset(form.getValues());
      clearBackup(backupKey);
      router.push(recipePath(props.homeId, props.recipeId));
    });
  }

  const publishedMode = props.mode === "published";
  const disabled = !hydrated || busy || (publishedMode && props.locked);
  const destinationName =
    destination === "" ? null : (props.homes.find((home) => home.id === destination)?.name ?? null);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (publishedMode) onSavePublished();
        else onSaveDraft();
      }}
      className="flex flex-col gap-6"
      data-testid="recipe-editor"
    >
      {props.mode !== "published" ? <FormAlert tone="info">{t("draftPrivacy")}</FormAlert> : null}
      {backup ? (
        <div className="flex flex-col gap-2 rounded-control border border-line bg-surface-sunken p-3">
          <p className="text-body text-fg">
            {backup.revision === backupRevision ? t("backupFound") : t("backupFoundOlder")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                form.reset(backup.values, { keepDefaultValues: true });
                setBackup(null);
              }}
            >
              {t("backupRestore")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                clearBackup(backupKey);
                setBackup(null);
              }}
            >
              {t("backupDiscard")}
            </Button>
          </div>
        </div>
      ) : null}
      <TextField
        label={t("fieldName")}
        {...(props.mode === "published" ? {} : { description: t("fieldNameDraftHelp") })}
        autoComplete="off"
        maxLength={RECIPE_FIELD_LIMITS.name * 2}
        error={message(errors.name)}
        {...form.register("name")}
      />
      {props.mode !== "published" ? (
        <SelectField
          label={t("fieldDestination")}
          description={t("fieldDestinationHelp")}
          value={destination}
          onChange={(event) => {
            setDestination(event.target.value);
          }}
          options={[
            { value: "", label: t("personalSpace") },
            ...props.homes.map((home) => ({ value: home.id, label: home.name })),
          ]}
          data-testid="recipe-destination"
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("fieldServings")}
          description={t("fieldServingsHelp")}
          inputMode="numeric"
          autoComplete="off"
          error={message(errors.servings)}
          {...form.register("servings")}
        />
        <TextField
          label={t("fieldServingsLabel")}
          description={t("fieldServingsLabelHelp")}
          autoComplete="off"
          maxLength={RECIPE_FIELD_LIMITS.servingsLabel * 2}
          error={message(errors.servingsLabel)}
          {...form.register("servingsLabel")}
        />
        <TextField
          label={t("fieldPrepMinutes")}
          inputMode="numeric"
          autoComplete="off"
          error={message(errors.prepMinutes)}
          {...form.register("prepMinutes")}
        />
        <TextField
          label={t("fieldCookMinutes")}
          inputMode="numeric"
          autoComplete="off"
          error={message(errors.cookMinutes)}
          {...form.register("cookMinutes")}
        />
      </div>

      <fieldset className="flex flex-col gap-3" data-testid="ingredient-rows">
        <legend className="text-section-title font-semibold text-fg">
          {t("ingredientsHeading")}
        </legend>
        <p className="text-helper text-fg-muted">{t("ingredientsHelp")}</p>
        {errors.ingredients?.message ? (
          <p className="text-helper text-danger">{message(errors.ingredients)}</p>
        ) : null}
        <ol className="flex flex-col gap-4">
          {ingredients.fields.map((field, index) => {
            const rowErrors = errors.ingredients?.[index];
            const position = index + 1;
            return (
              <li
                key={field.id}
                className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3"
              >
                <p className="text-helper font-medium text-fg-muted">
                  {t("ingredientNumber", { number: position })}
                </p>
                <div className="grid gap-3 sm:grid-cols-[8rem_10rem_1fr]">
                  <TextField
                    label={t("fieldQuantity")}
                    description={t("fieldQuantityHelp")}
                    autoComplete="off"
                    maxLength={20}
                    error={message(rowErrors?.quantity)}
                    {...form.register(ingredientField(index, "quantity"))}
                  />
                  <SelectField
                    label={t("fieldUnit")}
                    options={[
                      { value: "", label: t("unitNone") },
                      ...recipeUnits.map((unit) => ({
                        value: unit,
                        label: unitLabel(unit, null),
                      })),
                    ]}
                    {...form.register(ingredientField(index, "unit"))}
                  />
                  <TextField
                    label={t("fieldIngredientName")}
                    autoComplete="off"
                    maxLength={RECIPE_FIELD_LIMITS.ingredientName * 2}
                    error={message(rowErrors?.name)}
                    {...form.register(ingredientField(index, "name"))}
                  />
                </div>
                <TextField
                  label={t("fieldIngredientNote")}
                  description={t("fieldIngredientNoteHelp")}
                  autoComplete="off"
                  maxLength={RECIPE_FIELD_LIMITS.ingredientNote * 2}
                  error={message(rowErrors?.note)}
                  {...form.register(ingredientField(index, "note"))}
                />
                <RowActions
                  index={index}
                  count={ingredients.fields.length}
                  name={t("ingredientNumber", { number: position })}
                  onMove={(to) => {
                    ingredients.move(index, to);
                  }}
                  onRemove={() => {
                    ingredients.remove(index);
                  }}
                />
              </li>
            );
          })}
        </ol>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={ingredients.fields.length >= RECIPE_FIELD_LIMITS.ingredients}
            onClick={() => {
              ingredients.append(emptyIngredient());
            }}
          >
            {t("addIngredient")}
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3" data-testid="step-rows">
        <legend className="text-section-title font-semibold text-fg">{t("stepsHeading")}</legend>
        <ol className="flex flex-col gap-4">
          {steps.fields.map((field, index) => (
            <li key={field.id} className="flex flex-col gap-2">
              <TextArea
                label={t("stepNumber", { number: index + 1 })}
                rows={3}
                error={message(errors.steps?.[index]?.text)}
                {...form.register(stepField(index))}
              />
              <RowActions
                index={index}
                count={steps.fields.length}
                name={t("stepNumber", { number: index + 1 })}
                onMove={(to) => {
                  steps.move(index, to);
                }}
                onRemove={() => {
                  steps.remove(index);
                }}
              />
            </li>
          ))}
        </ol>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={steps.fields.length >= RECIPE_FIELD_LIMITS.steps}
            onClick={() => {
              steps.append({ text: "" });
            }}
          >
            {t("addStep")}
          </Button>
        </div>
      </fieldset>

      <Controller
        control={form.control}
        name="tags"
        render={({ field, fieldState }) => (
          <TagsField
            value={field.value}
            onChange={(tags) => {
              field.onChange(tags);
            }}
            error={message(fieldState.error)}
          />
        )}
      />
      <TextArea
        label={t("fieldNotes")}
        rows={4}
        error={message(errors.notes)}
        {...form.register("notes")}
      />
      <Controller
        control={form.control}
        name="coverFileId"
        render={({ field }) => (
          <CoverField
            value={field.value}
            saved={savedCover}
            onChange={field.onChange}
            target={{
              recipeId: created.current ? props.recipeId : null,
              lockToken: props.mode === "published" ? props.lockToken : null,
            }}
            disabled={disabled}
          />
        )}
      />

      <div ref={alertRef} tabIndex={-1} className="outline-none">
        {failure ? (
          <FormAlert tone="error" announce>
            {failureText(failure)}
          </FormAlert>
        ) : saved ? (
          <FormAlert tone="success" announce>
            {t("draftSaved")}
          </FormAlert>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {publishedMode ? (
          <>
            <Button type="submit" loading={busy} disabled={disabled} data-testid="recipe-save">
              {t("save")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                clearBackup(backupKey);
                props.onCancel();
              }}
            >
              {t("cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="submit"
              variant="secondary"
              loading={busy}
              disabled={disabled}
              data-testid="recipe-save-draft"
            >
              {t("saveDraft")}
            </Button>
            <Button disabled={disabled} onClick={onPublish} data-testid="recipe-publish">
              {t("publish")}
            </Button>
          </>
        )}
      </div>

      <Dialog
        open={publishing !== null}
        onClose={() => {
          setPublishing(null);
        }}
        title={t("publishTitle")}
        description={
          destinationName
            ? t("publishAudienceHome", { home: destinationName })
            : t("publishAudiencePersonal")
        }
        closeLabel={t("close")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPublishing(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button loading={busy} onClick={confirmPublish} data-testid="recipe-publish-confirm">
              {destinationName
                ? t("publishToHome", { home: destinationName })
                : t("publishPersonal")}
            </Button>
          </>
        }
      >
        {failure && publishing ? (
          <FormAlert tone="error" announce>
            {failureText(failure)}
          </FormAlert>
        ) : null}
      </Dialog>
    </form>
  );
}

function RowActions({
  index,
  count,
  name,
  onMove,
  onRemove,
}: {
  readonly index: number;
  readonly count: number;
  readonly name: string;
  readonly onMove: (to: number) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations("Recipes");
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={index === 0}
        aria-label={t("moveUpNamed", { name })}
        onClick={() => {
          onMove(index - 1);
        }}
      >
        {t("moveUp")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={index === count - 1}
        aria-label={t("moveDownNamed", { name })}
        onClick={() => {
          onMove(index + 1);
        }}
      >
        {t("moveDown")}
      </Button>
      <Button variant="ghost" size="sm" aria-label={t("removeNamed", { name })} onClick={onRemove}>
        {t("remove")}
      </Button>
    </div>
  );
}

interface Backup {
  readonly revision: number;
  readonly values: RecipeFormValues;
}

function readBackup(key: string): Backup | null {
  try {
    const text = window.sessionStorage.getItem(key);
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<Backup>;
    return typeof parsed.revision === "number" && parsed.values
      ? { revision: parsed.revision, values: parsed.values }
      : null;
  } catch {
    return null;
  }
}

function writeBackup(key: string, revision: number, values: RecipeFormValues) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ revision, values } satisfies Backup));
  } catch {
    // Storage may be full or blocked; the changes are still on the page.
  }
}

function clearBackup(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

type IngredientKey = "name" | "quantity" | "unit" | "note";

/** The form path of one ingredient row's field. */
function ingredientField<K extends IngredientKey>(index: number, key: K) {
  return `ingredients.${String(index)}.${key}` as `ingredients.${number}.${K}`;
}

/** The form path of one step's text. */
function stepField(index: number) {
  return `steps.${String(index)}.text` as `steps.${number}.text`;
}
