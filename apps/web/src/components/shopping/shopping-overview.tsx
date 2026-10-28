import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { secondaryLinkClass } from "@/components/recipes/link-styles";
import { PageHeader } from "@/components/shell/page-header";
import { TaskNotice } from "@/components/tasks/task-notice";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { advanceShopping, getShoppingContext, listShoppingLists } from "@/shopping/data";
import { shoppingListPath, shoppingPath, signalContextId } from "@/shopping/format";

import { ListMoveButtons, NewListButton } from "./list-actions";
import { ShoppingLive } from "./shopping-live";

export interface ShoppingOverviewProps {
  readonly userId: string;
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * The shopping lists of one context (S26): its active lists in their order with how many items
 * are left and completed, New list, Move up/down for its shopping managers, and the archive. Two
 * lists may share a name; their place in the order tells them apart. Read with the viewer's
 * session; live while open.
 */
export async function ShoppingOverview({ userId, home, searchParams }: ShoppingOverviewProps) {
  const homeId = home?.id ?? null;
  const archived = searchParams.view === "archived";
  const t = await getTranslations("Shopping");
  const advanced = await advanceShopping(homeId);
  // The signal version is read before the content, so a change committed in between makes the
  // live view refresh once instead of being taken as already shown.
  const context = await getShoppingContext(homeId);
  const lists = await listShoppingLists(homeId, archived);
  if (advanced.status !== "ok" || context.status !== "ok" || lists.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const names = new Map<string, number>();
  for (const list of lists.value) names.set(list.name, (names.get(list.name) ?? 0) + 1);

  return (
    <>
      <ShoppingLive
        contextId={signalContextId(homeId, userId)}
        version={context.value.signalVersion}
      />
      <PageHeader title={archived ? t("archivedTitle") : t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home ? home.name : t("personalSpace")}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link
          href={archived ? shoppingPath(homeId) : shoppingPath(homeId, "archived")}
          className="font-medium text-accent-fg underline"
          data-testid="shopping-archive-toggle"
        >
          {archived ? t("showActive") : t("showArchived")}
        </Link>
      </p>
      {searchParams.deleted === "1" ? (
        <TaskNotice>
          {t("listDeletedNotice")}{" "}
          <Link
            href={home ? `/homes/${home.id}/trash` : "/settings/trash"}
            className="font-medium text-accent-fg underline"
          >
            {t("openTrash")}
          </Link>
        </TaskNotice>
      ) : null}
      <div className="flex flex-col gap-5">
        {!archived && context.value.canCreate ? (
          <div className="flex flex-wrap gap-2">
            <NewListButton homeId={homeId} />
          </div>
        ) : null}
        {lists.value.length === 0 ? (
          <EmptyState
            title={archived ? t("noArchivedTitle") : t("emptyTitle")}
            description={archived ? t("noArchived") : t("emptyDescription")}
          />
        ) : (
          <ol className="flex flex-col gap-2" data-testid="shopping-lists">
            {lists.value.map((list, index) => (
              <li
                key={list.id}
                className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-4"
                data-testid="shopping-list-card"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Link
                    href={shoppingListPath(homeId, list.id)}
                    className="text-section-title font-semibold text-fg underline-offset-2 hover:underline"
                  >
                    <bdi>{list.name}</bdi>
                    {(names.get(list.name) ?? 0) > 1 ? (
                      <span className="ms-2 text-helper font-normal text-fg-muted">
                        {t("listPosition", { position: index + 1 })}
                      </span>
                    ) : null}
                  </Link>
                  <p className="text-helper text-fg-muted">
                    {t("listCounts", { active: list.activeItems, completed: list.completedItems })}
                    {list.memberAccess !== "edit" && homeId ? (
                      <>
                        {" \u{00B7} "}
                        {list.memberAccess === "check"
                          ? t("accessCheckShort")
                          : t("accessViewShort")}
                      </>
                    ) : null}
                  </p>
                </div>
                {!archived && context.value.canReorder && lists.value.length > 1 ? (
                  <ListMoveButtons
                    listId={list.id}
                    name={list.name}
                    first={index === 0}
                    last={index === lists.value.length - 1}
                  />
                ) : null}
                {archived ? (
                  <Link href={shoppingListPath(homeId, list.id)} className={secondaryLinkClass}>
                    {t("openList")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
