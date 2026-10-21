"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { LabelChip } from "@/components/tasks/label-chip";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_CATEGORIES_ENDPOINT,
  sendChoreRequest,
  type CategoryDeleteResponse,
  type ChoreCategory,
  type RevisionResponse,
} from "@/chores/api";
import { categoryNameSchema, CHORE_LIMITS } from "@/chores/schema";
import { labelColors, type LabelColor } from "@/tasks/schema";
import { noMembers } from "@/tasks/format";

import { useChoreFieldMessage } from "./chore-form";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

interface Editing {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

/**
 * A Home's chore categories (S20): add, rename, recolour, order with move buttons, archive
 * (retired: still shown on its chores, no longer offered) and delete after a preview of how many
 * chores it is on (they become uncategorized). A colour always comes with the name as text.
 */
export function CategoryManager({
  homeId,
  categories,
}: {
  readonly homeId: string;
  readonly categories: readonly ChoreCategory[];
}) {
  const t = useTranslations("Chores");
  const tAccent = useTranslations("Accent");
  const texts = useChoreTexts(noMembers);
  const message = useChoreFieldMessage();
  const { announce, region } = useAnnouncer();
  const firstColor = labelColors[0] ?? "";
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(firstColor);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<{ category: ChoreCategory; count: number } | null>(null);
  const colorOptions = labelColors.map((value) => ({ value, label: tAccent(value) }));
  const toColor = (value: string) => value as LabelColor;

  const create = useChoreMutation(
    `chore-category-create:${draftId}`,
    (input: { name: string; color: string }) =>
      sendChoreRequest<RevisionResponse>("POST", CHORE_CATEGORIES_ENDPOINT, {
        id: draftId,
        homeId,
        ...input,
      }),
    () => {
      announce(t("announceCategoryAdded"));
      setDraftId(crypto.randomUUID());
      setName("");
    },
  );
  const update = useChoreMutation(
    `chore-categories:${homeId}`,
    (input: { category: ChoreCategory; name: string; color: string; archived: boolean }) =>
      sendChoreRequest<RevisionResponse>(
        "PATCH",
        `${CHORE_CATEGORIES_ENDPOINT}/${input.category.id}`,
        {
          expectedRevision: input.category.revision,
          name: input.name,
          color: input.color,
          archived: input.archived,
        },
      ),
    () => {
      announce(t("announceSaved"));
      setEditing(null);
    },
  );
  const order = useChoreMutation(
    `chore-categories:${homeId}`,
    (ids: string[]) =>
      sendChoreRequest<{ outcome: string }>("PUT", CHORE_CATEGORIES_ENDPOINT, { homeId, ids }),
    () => {
      announce(t("announceOrdered"));
    },
  );
  const remove = useChoreMutation(
    `chore-categories:${homeId}`,
    (input: { category: ChoreCategory; dryRun: boolean }) =>
      sendChoreRequest<CategoryDeleteResponse>(
        "POST",
        `${CHORE_CATEGORIES_ENDPOINT}/${input.category.id}/delete`,
        { expectedRevision: input.category.revision, dryRun: input.dryRun },
      ),
    (result, input) => {
      if (input.dryRun) {
        setRemoving({ category: input.category, count: result.choreCount });
        return;
      }
      announce(t("announceCategoryDeleted"));
      setRemoving(null);
    },
    { refresh: (_, input) => !input.dryRun },
  );
  const error = create.error ?? update.error ?? order.error ?? (removing ? null : remove.error);
  const active = categories.filter((category) => !category.archived);
  const archived = categories.filter((category) => category.archived);
  const move = (index: number, by: -1 | 1) => {
    const ids = active.map((category) => category.id);
    const [id] = ids.splice(index, 1);
    if (id) ids.splice(index + by, 0, id);
    order.mutate(ids);
  };
  const parseName = (value: string) => {
    const parsed = categoryNameSchema.safeParse(value);
    return parsed.success ? { name: parsed.data } : { error: message(parsed.error.issues[0]) };
  };

  const row = (category: ChoreCategory, index: number | null) => (
    <li key={category.id} className="flex flex-col gap-2 p-3" data-testid="chore-category">
      {editing?.id === category.id ? (
        <div className="flex flex-col gap-3">
          <TextField
            label={t("categoryName")}
            value={editing.name}
            maxLength={CHORE_LIMITS.categoryName * 2}
            onChange={(event) => {
              setEditing({ ...editing, name: event.target.value });
            }}
          />
          <SelectField
            label={t("categoryColor")}
            value={editing.color}
            options={colorOptions}
            onChange={(event) => {
              setEditing({ ...editing, color: event.target.value });
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={update.busy}
              onClick={() => {
                const parsed = parseName(editing.name);
                if (!parsed.name) return;
                update.mutate({
                  category,
                  name: parsed.name,
                  color: toColor(editing.color),
                  archived: category.archived,
                });
              }}
            >
              {t("save")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditing(null);
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <LabelChip name={category.name} color={category.color} />
            <span className="text-helper text-fg-muted">
              {t("categoryUse", { count: category.choreCount })}
            </span>
          </span>
          <span className="flex flex-wrap gap-1">
            {index !== null ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0 || order.busy}
                  onClick={() => {
                    move(index, -1);
                  }}
                  aria-label={t("moveCategoryUp", { name: category.name })}
                >
                  {t("moveUp")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === active.length - 1 || order.busy}
                  onClick={() => {
                    move(index, 1);
                  }}
                  aria-label={t("moveCategoryDown", { name: category.name })}
                >
                  {t("moveDown")}
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing({
                  id: category.id,
                  name: category.name,
                  color: category.color ?? firstColor,
                });
              }}
              aria-label={t("editCategory", { name: category.name })}
            >
              {t("edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={update.busy}
              onClick={() => {
                update.mutate({
                  category,
                  name: category.name,
                  color: category.color ?? firstColor,
                  archived: !category.archived,
                });
              }}
              aria-label={
                category.archived
                  ? t("unarchiveCategory", { name: category.name })
                  : t("archiveCategory", { name: category.name })
              }
            >
              {category.archived ? t("unarchive") : t("archive")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                remove.mutate({ category, dryRun: true });
              }}
              aria-label={t("deleteCategory", { name: category.name })}
            >
              {t("delete")}
            </Button>
          </span>
        </div>
      )}
    </li>
  );

  return (
    <section aria-labelledby="chore-categories-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-categories-heading" className="text-section-title font-semibold text-fg">
          {t("categoriesHeading")}
        </h2>
        <p className="text-helper text-fg-muted">{t("categoriesHelp")}</p>
        <form
          noValidate
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseName(name);
            setNameError(parsed.error);
            if (parsed.name) create.mutate({ name: parsed.name, color });
          }}
          data-testid="chore-category-form"
        >
          <TextField
            label={t("categoryName")}
            value={name}
            maxLength={CHORE_LIMITS.categoryName * 2}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
            }}
            error={nameError}
          />
          <SelectField
            label={t("categoryColor")}
            value={color}
            options={colorOptions}
            onChange={(event) => {
              setColor(event.target.value);
            }}
          />
          <Button
            type="submit"
            loading={create.busy}
            disabled={categories.length >= CHORE_LIMITS.categories}
          >
            {t("addCategory")}
          </Button>
        </form>
        {error ? (
          <FormAlert tone="error" announce>
            {texts.failure(error.failure)}
          </FormAlert>
        ) : null}
        {active.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
            {active.map((category, index) => row(category, index))}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">{t("noCategories")}</p>
        )}
        {archived.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-body font-medium text-fg">
              {t("archivedCategories", { count: archived.length })}
            </summary>
            <ul className="mt-2 flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
              {archived.map((category) => row(category, null))}
            </ul>
          </details>
        ) : null}
        <Dialog
          open={removing !== null}
          onClose={() => {
            setRemoving(null);
          }}
          title={t("deleteCategoryTitle")}
          description={
            removing
              ? t("deleteCategoryBody", { name: removing.category.name, count: removing.count })
              : ""
          }
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setRemoving(null);
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                loading={remove.busy}
                onClick={() => {
                  if (removing) remove.mutate({ category: removing.category, dryRun: false });
                }}
                data-testid="chore-category-delete-confirm"
              >
                {t("delete")}
              </Button>
            </>
          }
        >
          {remove.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(remove.error.failure)}
            </FormAlert>
          ) : null}
        </Dialog>
      </HydrationGate>
    </section>
  );
}
