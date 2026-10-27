"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  RECIPE_IMPORT_ENDPOINT,
  RecipeRequestError,
  sendRecipeRequest,
  type RecipeFailure,
  type RecipeImportFailure,
  type RecipeImportPreview,
  type RecipeImportWarning,
} from "@/recipes/api";
import { draftPath, newRecipePath, recipePath } from "@/recipes/format";
import { emptyIngredient, SOURCE_URL_MAX, type RecipeFormValues } from "@/recipes/schema";

import { RecipeEditor, type HomeOption } from "./recipe-editor";
import { RecipeSource } from "./recipe-source";
import { useRecipeFailure } from "./use-recipe-texts";

export interface RecipeImportProps {
  /** The context the import was started from: the default destination. */
  readonly homeId: string | null;
  readonly homes: readonly HomeOption[];
}

const reasonKey = {
  invalid_url: "importReasonInvalidUrl",
  blocked: "importReasonBlocked",
  unreachable: "importReasonUnreachable",
  timeout: "importReasonTimeout",
  too_large: "importReasonTooLarge",
  not_html: "importReasonNotHtml",
  restricted: "importReasonRestricted",
  not_found: "importReasonNotFound",
  no_recipe: "importReasonNoRecipe",
} as const satisfies Record<RecipeImportFailure, string>;

const warningKey = {
  noName: "importWarningNoName",
  noIngredients: "importWarningNoIngredients",
  noSteps: "importWarningNoSteps",
  noServings: "importWarningNoServings",
  ambiguousServings: "importWarningAmbiguousServings",
  ingredientsAsWritten: "importWarningAsWritten",
  textShortened: "importWarningShortened",
  tooManyItems: "importWarningTooMany",
  timeOutOfRange: "importWarningTime",
  photoNotCopied: "importWarningPhoto",
} as const satisfies Record<RecipeImportWarning, string>;

/** What an import found, as the editor's starting values. Nothing is added that the page did not state. */
export function previewToForm(preview: RecipeImportPreview): RecipeFormValues {
  const text = (value: number | null) => (value === null ? "" : String(value));
  return {
    name: preview.name ?? "",
    servings: text(preview.servings),
    servingsLabel: preview.servingsLabel ?? "",
    prepMinutes: text(preview.prepMinutes),
    cookMinutes: text(preview.cookMinutes),
    notes: preview.notes ?? "",
    tags: [...preview.tags],
    ingredients:
      preview.ingredients.length > 0
        ? preview.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit ?? "",
            note: "",
          }))
        : [emptyIngredient()],
    steps:
      preview.steps.length > 0 ? preview.steps.map((step) => ({ text: step })) : [{ text: "" }],
    coverFileId: null,
  };
}

type Failure =
  | { readonly kind: "import"; readonly reason: RecipeImportFailure | null }
  | { readonly kind: "request"; readonly failure: RecipeFailure };

/**
 * Importing a recipe from a public web page (S25, spec "recipe URL import with editable preview"):
 * pick the destination, paste the address, and the server reads the page's recipe. The result is
 * a review: its source, what is missing or uncertain, likely duplicates in the destination, then
 * the ordinary editor filled in, where everything can be corrected before Save draft or Publish
 * (with the usual audience confirmation). Cancelling or leaving saves nothing. When the page
 * cannot be read, the reason is shown with a way to enter the recipe by hand.
 */
export function RecipeImport({ homeId, homes }: RecipeImportProps) {
  const t = useTranslations("Recipes");
  const hydrated = useHydrated();
  const failureText = useRecipeFailure();
  const [destination, setDestination] = useState(homeId ?? "");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [preview, setPreview] = useState<{
    readonly value: RecipeImportPreview;
    readonly recipeId: string;
    readonly homeId: string | null;
  } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const target = destination === "" ? null : destination;
  const previewId = preview?.recipeId ?? null;

  // Focus moves once the review or the refusal is on screen (after React commits, not before).
  useEffect(() => {
    if (previewId) reviewRef.current?.focus();
  }, [previewId]);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  async function onImport() {
    setBusy(true);
    setFailure(null);
    try {
      const value = await sendRecipeRequest<RecipeImportPreview>("POST", RECIPE_IMPORT_ENDPOINT, {
        url: url.trim(),
        homeId: target,
      });
      // A fresh id per preview: saving it twice answers the same recipe, never a second one.
      setPreview({ value, recipeId: crypto.randomUUID(), homeId: target });
    } catch (error) {
      const refused =
        error instanceof RecipeRequestError ? error : new RecipeRequestError("failed");
      setFailure(
        refused.failure === "importFailed"
          ? { kind: "import", reason: refused.importReason }
          : { kind: "request", failure: refused.failure },
      );
    } finally {
      setBusy(false);
    }
  }

  if (preview) {
    const found = preview.value;
    return (
      <div className="flex flex-col gap-6" data-testid="recipe-import-review">
        <section aria-labelledby="import-review-heading" className="flex flex-col gap-3">
          <h2
            id="import-review-heading"
            ref={reviewRef}
            tabIndex={-1}
            className="text-section-title font-semibold text-fg focus-visible:outline-2 focus-visible:outline-focus"
          >
            {t("importReviewHeading")}
          </h2>
          <p className="text-body text-fg">{t("importReviewIntro")}</p>
          <RecipeSource source={found.source} />
          {found.warnings.length > 0 ? (
            <FormAlert tone="info">
              <ul className="list-disc ps-5" data-testid="recipe-import-warnings">
                {found.warnings.map((warning) => (
                  <li key={warning}>{t(warningKey[warning])}</li>
                ))}
              </ul>
            </FormAlert>
          ) : null}
          {found.duplicates.length > 0 ? (
            <FormAlert tone="info">
              <p>{t("importDuplicates")}</p>
              <ul className="list-disc ps-5" data-testid="recipe-import-duplicates">
                {found.duplicates.map((duplicate) => (
                  <li key={duplicate.id}>
                    <Link
                      href={
                        duplicate.status === "draft"
                          ? draftPath(duplicate.id)
                          : recipePath(preview.homeId, duplicate.id)
                      }
                      className="font-medium text-accent-fg underline"
                    >
                      <bdi>{duplicate.name ?? t("untitled")}</bdi>
                    </Link>{" "}
                    {duplicate.match === "source"
                      ? t("importDuplicateSource")
                      : t("importDuplicateName")}
                  </li>
                ))}
              </ul>
            </FormAlert>
          ) : null}
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setPreview(null);
              }}
              data-testid="recipe-import-start-over"
            >
              {t("importStartOver")}
            </Button>
          </div>
        </section>
        <RecipeEditor
          key={preview.recipeId}
          mode="new"
          recipeId={preview.recipeId}
          homeId={preview.homeId}
          homes={homes}
          initial={previewToForm(found)}
          source={found.source}
        />
      </div>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void onImport();
      }}
      data-testid="recipe-import-form"
    >
      <p className="text-body text-fg">{t("importIntro")}</p>
      <SelectField
        label={t("fieldDestination")}
        description={t("importDestinationHelp")}
        value={destination}
        onChange={(event) => {
          setDestination(event.target.value);
        }}
        options={[
          { value: "", label: t("personalSpace") },
          ...homes.map((home) => ({ value: home.id, label: home.name })),
        ]}
        data-testid="recipe-import-destination"
      />
      <TextField
        label={t("importUrlLabel")}
        description={t("importUrlHelp")}
        type="url"
        inputMode="url"
        autoComplete="off"
        required
        maxLength={SOURCE_URL_MAX}
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
        }}
        data-testid="recipe-import-url"
      />
      {failure ? (
        <div ref={alertRef} tabIndex={-1} data-testid="recipe-import-failure">
          <FormAlert tone="error" announce>
            <p>
              {failure.kind === "import"
                ? t(reasonKey[failure.reason ?? "unreachable"])
                : failureText(failure.failure)}
            </p>
            {failure.kind === "import" || failure.failure === "rateLimited" ? (
              <p className="mt-2">
                <Link
                  href={newRecipePath(target)}
                  className="font-medium text-accent-fg underline"
                  data-testid="recipe-import-manual"
                >
                  {t("importManual")}
                </Link>
              </p>
            ) : null}
          </FormAlert>
        </div>
      ) : null}
      <div>
        <Button
          type="submit"
          loading={busy}
          disabled={!hydrated || url.trim() === ""}
          data-testid="recipe-import-submit"
        >
          {busy ? t("importBusy") : t("importSubmit")}
        </Button>
      </div>
    </form>
  );
}
