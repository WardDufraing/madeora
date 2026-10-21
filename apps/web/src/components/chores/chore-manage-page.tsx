import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { LabelChip } from "@/components/tasks/label-chip";
import { EmptyState, ErrorState } from "@/components/ui/states";
import type { ChoreSummary } from "@/chores/api";
import {
  getChoreContext,
  getChoreSettings,
  listChoreCategories,
  listChores,
  listChoreTemplates,
} from "@/chores/data";
import { choresPath } from "@/chores/format";
import { getDateTimeFormats } from "@/invitations/server";
import { formatTaskDate } from "@/tasks/format";

import { CategoryManager } from "./category-manager";
import { ChoreSettingsForm } from "./chore-settings-form";
import { TemplateManager } from "./template-manager";

/**
 * Managing a Home's chores (S20, chore managers): every chore, active and ended, with its state
 * and the occurrence to open, the Home's chore templates and its categories, and (S21) the Home's
 * chore settings. Anyone else is told so, and the database
 * refuses their changes anyway.
 */
export async function ChoreManagePage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string };
}) {
  const [t, formats, context, active, ended, categories, templates, settings] = await Promise.all([
    getTranslations("Chores"),
    getDateTimeFormats(),
    getChoreContext(home.id),
    listChores(home.id, false),
    listChores(home.id, true),
    listChoreCategories(home.id, true),
    listChoreTemplates(home.id, true),
    getChoreSettings(home.id),
  ]);
  const base = choresPath(home.id);
  const header = (
    <>
      <PageHeader title={t("manageTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={base} className="font-medium text-accent-fg underline">
          {t("backToChores")}
        </Link>
      </p>
    </>
  );
  if (
    context.status !== "ok" ||
    active.status !== "ok" ||
    ended.status !== "ok" ||
    categories.status !== "ok" ||
    templates.status !== "ok" ||
    settings.status !== "ok"
  ) {
    return (
      <>
        {header}
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      </>
    );
  }
  if (!context.value.canManage) {
    return (
      <>
        {header}
        <EmptyState title={t("manageNotAllowedTitle")} description={t("manageNotAllowed")} />
      </>
    );
  }
  const state = (chore: ChoreSummary) =>
    chore.paused
      ? t("statePaused")
      : chore.finished
        ? t("stateFinished")
        : chore.nextDue
          ? t("stateNext", { date: formatTaskDate(chore.nextDue, formats) })
          : t("stateNoOpen");
  const list = (chores: readonly ChoreSummary[], endedList: boolean) => (
    <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
      {chores.map((chore) => (
        <li
          key={chore.id}
          className="flex flex-wrap items-center justify-between gap-2 p-3"
          data-testid="managed-chore"
        >
          <div className="flex min-w-0 flex-col gap-1">
            {chore.occurrenceId ? (
              <Link
                href={`${base}/${chore.occurrenceId}`}
                className="text-body font-semibold text-fg underline-offset-2 hover:underline"
              >
                <bdi>{chore.title}</bdi>
              </Link>
            ) : (
              <bdi className="text-body font-semibold text-fg">{chore.title}</bdi>
            )}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
              {chore.category ? (
                <LabelChip name={chore.category.name} color={chore.category.color} />
              ) : (
                <span>{t("uncategorized")}</span>
              )}
              <span>{chore.kind === "recurring" ? t("repeats") : t("oneOff")}</span>
              <span>
                {chore.assignment === "rotating"
                  ? t("assignmentRotating")
                  : chore.assignment === "fixed"
                    ? t("assignmentFixed")
                    : t("assignmentNone")}
              </span>
              <span>{endedList ? t("stateEnded") : state(chore)}</span>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {header}
      <div className="flex max-w-3xl flex-col gap-10">
        <section aria-labelledby="managed-chores-heading" className="flex flex-col gap-3">
          <h2 id="managed-chores-heading" className="text-section-title font-semibold text-fg">
            {t("choresHeading")}
          </h2>
          {active.value.length === 0 ? (
            <p className="text-body text-fg-muted">{t("noChores")}</p>
          ) : (
            list(active.value, false)
          )}
          {ended.value.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-body font-medium text-fg">
                {t("endedChores", { count: ended.value.length })}
              </summary>
              <div className="mt-2">{list(ended.value, true)}</div>
            </details>
          ) : null}
        </section>
        <TemplateManager
          homeId={home.id}
          templates={templates.value}
          categories={categories.value
            .filter((category) => !category.archived)
            .map(({ id, name }) => ({ id, name }))}
        />
        <CategoryManager homeId={home.id} categories={categories.value} />
        <ChoreSettingsForm homeId={home.id} settings={settings.value} />
      </div>
    </>
  );
}
