import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import type { RecipeDetail, RecipePerson } from "@/recipes/api";
import { getRecipe } from "@/recipes/data";
import { recipePath, recipesPath, servingsFromParam } from "@/recipes/format";
import { listTaskMembers } from "@/tasks/data";
import { memberNames, personName, type MemberNames } from "@/tasks/format";

import { primaryLinkClass, secondaryLinkClass } from "./link-styles";
import { RecipeCover } from "./recipe-cover";
import { RecipeDelete } from "./recipe-delete";
import { RecipeTimes } from "./recipe-meta";
import { RecipeFavorite, RecipeRating } from "./recipe-reactions";
import { RecipeServings } from "./recipe-servings";

export interface RecipeDetailPageProps {
  readonly recipeId: string;
  /** The context the address names; a recipe of another context (or a draft) is not found here. */
  readonly homeId: string | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * One published recipe (S24): cover, times, tags, the ingredients for the selected servings,
 * steps, notes, the viewer's favorite and rating, who added and last changed it, and Edit, Cook
 * and Delete as their rights allow. Read with the viewer's session; a draft is never shown here
 * (drafts live under My drafts, for their creator only).
 */
export async function RecipeDetailPage({ recipeId, homeId, searchParams }: RecipeDetailPageProps) {
  const [t, formats, recipe] = await Promise.all([
    getTranslations("Recipes"),
    getDateTimeFormats(),
    getRecipe(recipeId),
  ]);
  if (recipe.status === "not-found") notFound();
  if (recipe.status === "unavailable") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const detail = recipe.value;
  if (detail.status !== "published" || detail.homeId !== homeId) notFound();
  const members = homeId ? await listTaskMembers(homeId) : ({ status: "ok", value: [] } as const);
  if (members.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const names = memberNames(members.value);
  const who = (person: RecipePerson) => personText(person, names, t);

  return (
    <>
      <p className="mb-2">
        <Link href={recipesPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToLibrary")}
        </Link>
      </p>
      <PageHeader title={detail.name ?? t("untitled")} />
      <div className="flex flex-col gap-6" data-testid="recipe-detail">
        <RecipeCover fileId={detail.coverFileId} size="hero" />
        <LockNotice recipe={detail} names={names} />
        <div className="flex flex-wrap gap-2">
          {detail.steps.length > 0 ? (
            <Link
              href={`${recipePath(homeId, detail.id, "cook")}${servingsQuery(searchParams)}`}
              className={primaryLinkClass}
              data-testid="recipe-cook"
            >
              {t("startCooking")}
            </Link>
          ) : null}
          {detail.can.edit ? (
            <Link
              href={recipePath(homeId, detail.id, "edit")}
              className={secondaryLinkClass}
              data-testid="recipe-edit"
            >
              {t("editRecipe")}
            </Link>
          ) : null}
          {detail.can.delete ? (
            <RecipeDelete recipeId={detail.id} draft={false} after={recipesPath(homeId)} />
          ) : null}
        </div>
        <RecipeTimes prepMinutes={detail.prepMinutes} cookMinutes={detail.cookMinutes} />
        {detail.tags.length > 0 ? (
          <ul aria-label={t("tagsLabel")} className="flex flex-wrap gap-1">
            {detail.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-surface-sunken px-2 py-0.5 text-helper text-fg-muted"
              >
                <bdi>{tag}</bdi>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <section aria-labelledby="ingredients-heading" className="flex flex-col gap-3 lg:w-80">
            <h2 id="ingredients-heading" className="text-section-title font-semibold text-fg">
              {t("ingredientsHeading")}
            </h2>
            {detail.ingredients.length === 0 ? (
              <p className="text-body text-fg-muted">{t("noIngredients")}</p>
            ) : (
              <RecipeServings
                ingredients={detail.ingredients}
                original={detail.servings}
                servingsLabel={detail.servingsLabel}
                initial={servingsFromParam(searchParams.servings)}
              />
            )}
          </section>
          <section aria-labelledby="steps-heading" className="flex min-w-0 flex-1 flex-col gap-3">
            <h2 id="steps-heading" className="text-section-title font-semibold text-fg">
              {t("stepsHeading")}
            </h2>
            {detail.steps.length === 0 ? (
              <p className="text-body text-fg-muted">{t("noSteps")}</p>
            ) : (
              <ol className="flex list-decimal flex-col gap-3 ps-6" data-testid="recipe-steps">
                {detail.steps.map((step, index) => (
                  // Steps may repeat word for word; their position is their identity.
                  <li key={index} className="whitespace-pre-line text-body text-fg">
                    {step}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
        {detail.notes ? (
          <section aria-labelledby="notes-heading" className="flex flex-col gap-2">
            <h2 id="notes-heading" className="text-section-title font-semibold text-fg">
              {t("notesHeading")}
            </h2>
            <p className="whitespace-pre-line text-body text-fg">{detail.notes}</p>
          </section>
        ) : null}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
          <RecipeRating recipeId={detail.id} rating={detail.rating} />
          <RecipeFavorite recipeId={detail.id} favorite={detail.favorite} />
        </div>
        <p className="text-helper text-fg-muted">
          {t("addedByOn", {
            person: who(detail.createdBy),
            date: formatDateTime(detail.publishedAt ?? detail.createdAt, formats),
          })}{" "}
          {t("updatedByOn", {
            person: who(detail.updatedBy),
            date: formatDateTime(detail.updatedAt, formats),
          })}
        </p>
      </div>
    </>
  );
}

function servingsQuery(searchParams: RecipeDetailPageProps["searchParams"]): string {
  const servings = servingsFromParam(searchParams.servings);
  return servings === null ? "" : `?servings=${String(servings)}`;
}

type Translate = Awaited<ReturnType<typeof getTranslations<"Recipes">>>;

function personText(person: RecipePerson, names: MemberNames, t: Translate): string {
  const name = personName(person, names);
  switch (name.kind) {
    case "me":
      return t("personYou");
    case "member":
      return name.name;
    case "unnamed":
      return t("personUnnamed");
    default:
      return t("personFormer");
  }
}

/** Someone is editing it right now: who (in a Home), or "you, in another tab or device". */
async function LockNotice({
  recipe,
  names,
}: {
  readonly recipe: RecipeDetail;
  readonly names: MemberNames;
}) {
  if (!recipe.lock) return null;
  const t = await getTranslations("Recipes");
  const text = recipe.lock.mine
    ? t("lockedByYou")
    : t("lockedBy", {
        person: personText({ me: false, member: recipe.lock.member }, names, t),
      });
  return (
    <p
      role="status"
      className="rounded-control border border-line bg-surface-sunken p-3 text-body text-fg"
      data-testid="recipe-lock-notice"
    >
      {text}
    </p>
  );
}
