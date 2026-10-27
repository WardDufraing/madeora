import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { TaskNotice } from "@/components/tasks/task-notice";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { listMyHomes } from "@/homes/server";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getRecipe, getRecipeContext, listMyDrafts, listRecipeShares } from "@/recipes/data";
import {
  DRAFTS_PATH,
  draftPath,
  recipePath,
  recipesPath,
  servingsFromParam,
  toRecipeForm,
} from "@/recipes/format";
import { emptyRecipeForm } from "@/recipes/schema";
import { listTaskMembers } from "@/tasks/data";

import { primaryLinkClass } from "./link-styles";
import { CookingMode } from "./cooking-mode";
import { RecipeCover } from "./recipe-cover";
import { RecipeDelete } from "./recipe-delete";
import { RecipeEditSession } from "./recipe-edit-session";
import { RecipeEditor } from "./recipe-editor";
import { RecipeImport } from "./recipe-import";
import { RecipeSharePanel } from "./recipe-share-panel";

async function homeOptions() {
  const homes = await listMyHomes();
  return homes.status === "ok" ? homes.homes.map(({ id, name }) => ({ id, name })) : null;
}

/** A new recipe (S24), started from a context: that context is its default destination. */
export async function NewRecipePage({ homeId }: { readonly homeId: string | null }) {
  const [t, context, homes] = await Promise.all([
    getTranslations("Recipes"),
    getRecipeContext(homeId),
    homeOptions(),
  ]);
  if (context.status === "not-found") notFound();
  if (context.status !== "ok" || homes === null) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  return (
    <>
      <p className="mb-2">
        <Link href={recipesPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToLibrary")}
        </Link>
      </p>
      <PageHeader title={t("newRecipeTitle")} />
      <NewRecipeEditor homeId={homeId} homes={homes} />
    </>
  );
}

function NewRecipeEditor({
  homeId,
  homes,
}: {
  readonly homeId: string | null;
  readonly homes: readonly { readonly id: string; readonly name: string }[];
}) {
  // The id is the client's: a retried save answers the same draft instead of a second one.
  return (
    <RecipeEditor
      mode="new"
      recipeId={crypto.randomUUID()}
      homeId={homeId}
      homes={homes}
      initial={emptyRecipeForm()}
    />
  );
}

/** Importing a recipe from a web page (S25), started from a context: its default destination. */
export async function ImportRecipePage({ homeId }: { readonly homeId: string | null }) {
  const [t, context, homes] = await Promise.all([
    getTranslations("Recipes"),
    getRecipeContext(homeId),
    homeOptions(),
  ]);
  if (context.status === "not-found") notFound();
  if (context.status !== "ok" || homes === null) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  return (
    <>
      <p className="mb-2">
        <Link href={recipesPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToLibrary")}
        </Link>
      </p>
      <PageHeader title={t("importTitle")} />
      <RecipeImport homeId={homeId} homes={homes} />
    </>
  );
}

/** Where a recipe is shared (S25): for a recipe manager of its origin, seen from where it lives. */
export async function ShareRecipePage({
  recipeId,
  homeId,
}: {
  readonly recipeId: string;
  readonly homeId: string | null;
}) {
  const t = await getTranslations("Recipes");
  const recipe = await loadPublished(recipeId, homeId);
  if (!recipe) return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  const back = (
    <p className="mb-2">
      <Link
        href={recipePath(homeId, recipe.id)}
        className="text-body font-medium text-accent-fg underline"
      >
        {t("backToRecipe")}
      </Link>
    </p>
  );
  if (recipe.sharedIn || !recipe.can.share) {
    return (
      <>
        {back}
        <PageHeader title={recipe.name ?? t("untitled")} />
        <ErrorState title={t("cannotShareTitle")} description={t("cannotShare")} />
      </>
    );
  }
  const shares = await listRecipeShares(recipe.id);
  if (shares.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  return (
    <>
      {back}
      <PageHeader title={t("shareTitle", { name: recipe.name ?? t("untitled") })} />
      <RecipeSharePanel
        recipeId={recipe.id}
        recipeName={recipe.name ?? t("untitled")}
        shares={shares.value}
      />
    </>
  );
}

/** My drafts (S24): the signed-in person's own drafts, never anyone else's, whatever their role. */
export async function DraftsPage({
  searchParams,
}: {
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const [t, formats, drafts] = await Promise.all([
    getTranslations("Recipes"),
    getDateTimeFormats(),
    listMyDrafts(),
  ]);
  if (drafts.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  return (
    <>
      <p className="mb-2">
        <Link href="/recipes" className="text-body font-medium text-accent-fg underline">
          {t("backToPersonalLibrary")}
        </Link>
      </p>
      <PageHeader title={t("draftsTitle")} />
      <p className="mb-4 text-body text-fg-muted">{t("draftsIntro")}</p>
      {searchParams.deleted === "1" ? (
        <TaskNotice>
          {t("draftDiscardedNotice")}{" "}
          <Link href="/settings/trash" className="font-medium text-accent-fg underline">
            {t("openTrash")}
          </Link>
        </TaskNotice>
      ) : null}
      {drafts.value.length === 0 ? (
        <EmptyState
          title={t("noDraftsTitle")}
          description={t("noDrafts")}
          action={
            <Link href="/recipes/new" className={primaryLinkClass}>
              {t("newRecipe")}
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="recipe-drafts">
          {drafts.value.map((draft) => (
            <li
              key={draft.id}
              className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3 sm:flex-row sm:items-center"
            >
              <div className="w-full sm:w-32 sm:shrink-0">
                <RecipeCover fileId={draft.coverFileId} size="card" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h2 className="text-body font-semibold text-fg">
                  <bdi>{draft.name ?? t("untitled")}</bdi>
                </h2>
                <p className="text-helper text-fg-muted">
                  {t("lastEdited", { date: formatDateTime(draft.updatedAt, formats) })}
                </p>
                <p className="text-helper text-fg-muted">
                  {draft.destinationLost
                    ? t("destinationLost")
                    : draft.destinationHomeName
                      ? t("destinationHome", { home: draft.destinationHomeName })
                      : t("destinationPersonal")}
                </p>
              </div>
              <Link
                href={draftPath(draft.id)}
                className={primaryLinkClass}
                aria-label={t("resumeNamed", { name: draft.name ?? t("untitled") })}
              >
                {t("resume")}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One of the person's drafts in the editor (S24); a published one goes to its page instead. */
export async function DraftPage({ draftId }: { readonly draftId: string }) {
  const [t, recipe, homes] = await Promise.all([
    getTranslations("Recipes"),
    getRecipe(draftId),
    homeOptions(),
  ]);
  if (recipe.status === "not-found") notFound();
  if (recipe.status !== "ok" || homes === null) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const draft = recipe.value;
  if (draft.status === "published") redirect(recipePath(draft.homeId, draft.id));
  return (
    <>
      <p className="mb-2">
        <Link href={DRAFTS_PATH} className="text-body font-medium text-accent-fg underline">
          {t("backToDrafts")}
        </Link>
      </p>
      <PageHeader title={draft.name ?? t("untitled")} />
      {draft.destinationLost ? (
        <p
          role="status"
          className="mb-4 rounded-control border border-line bg-surface-sunken p-3 text-body text-fg"
        >
          {t("destinationLostNotice")}
        </p>
      ) : null}
      <div className="flex flex-col gap-6">
        <RecipeEditor
          key={draft.revision}
          mode="draft"
          recipeId={draft.id}
          revision={draft.revision}
          destination={draft.draftHomeId}
          homes={homes}
          initial={toRecipeForm(draft)}
        />
        <div>
          <RecipeDelete recipeId={draft.id} draft after={DRAFTS_PATH} />
        </div>
      </div>
    </>
  );
}

/**
 * A published recipe seen from the context the address names: a Home (its own recipes and those
 * shared with it, S25) or the Personal space (its own only). Anything else is not found here.
 */
export async function loadPublished(recipeId: string, homeId: string | null) {
  const recipe = await getRecipe(recipeId, homeId);
  if (recipe.status === "not-found") notFound();
  if (recipe.status !== "ok") return null;
  if (recipe.value.status !== "published" || (homeId === null && recipe.value.homeId !== null)) {
    notFound();
  }
  return recipe.value;
}

/** Editing a published recipe under its exclusive lock (S24). */
export async function EditRecipePage({
  recipeId,
  homeId,
}: {
  readonly recipeId: string;
  readonly homeId: string | null;
}) {
  const t = await getTranslations("Recipes");
  const recipe = await loadPublished(recipeId, homeId);
  const members = homeId ? await listTaskMembers(homeId) : ({ status: "ok", value: [] } as const);
  if (!recipe || members.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  if (!recipe.can.edit) {
    return (
      <>
        <PageHeader title={recipe.name ?? t("untitled")} />
        <ErrorState title={t("cannotEditTitle")} description={t("cannotEdit")} />
      </>
    );
  }
  return (
    <>
      <p className="mb-2">
        <Link
          href={recipePath(homeId, recipe.id)}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToRecipe")}
        </Link>
      </p>
      <PageHeader title={t("editTitle", { name: recipe.name ?? t("untitled") })} />
      <RecipeEditSession
        recipeId={recipe.id}
        homeId={homeId}
        revision={recipe.revision}
        initial={toRecipeForm(recipe)}
        members={members.value}
        shared={recipe.isShared}
      />
    </>
  );
}

/** Cooking mode of a published recipe (S24). */
export async function CookRecipePage({
  recipeId,
  homeId,
  searchParams,
}: {
  readonly recipeId: string;
  readonly homeId: string | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("Recipes");
  const recipe = await loadPublished(recipeId, homeId);
  if (!recipe) return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  return (
    <>
      <PageHeader title={t("cookingTitle", { name: recipe.name ?? t("untitled") })} />
      <CookingMode
        key={recipe.revision}
        recipe={recipe}
        homeId={homeId}
        initialServings={servingsFromParam(searchParams.servings)}
      />
    </>
  );
}
