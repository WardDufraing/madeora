import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { zonedParts } from "@/chores/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getShoppingContext, getShoppingList } from "@/shopping/data";
import { shoppingPath, signalContextId } from "@/shopping/format";
import { listTaskMembers } from "@/tasks/data";

import { ShoppingListView } from "./shopping-list-view";
import { ShoppingLive } from "./shopping-live";

export interface ShoppingListPageProps {
  readonly userId: string;
  readonly listId: string;
  /** The context the address names; a list of another context is not found here. */
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string } | null;
}

/**
 * One shopping list (S26): quick add, its items by category in their order, the Completed section,
 * and editing, moving, repeating and settings as the viewer's access allows. Read with the
 * viewer's session after applying due recurring items; live while open.
 */
export async function ShoppingListPage({ userId, listId, home }: ShoppingListPageProps) {
  const homeId = home?.id ?? null;
  // The signal version is read before the content, so a change committed in between makes the
  // live view refresh once instead of being taken as already shown.
  const context = await getShoppingContext(homeId);
  const [t, formats, list, members] = await Promise.all([
    getTranslations("Shopping"),
    getDateTimeFormats(),
    getShoppingList(listId, homeId),
    homeId ? listTaskMembers(homeId) : Promise.resolve({ status: "ok", value: [] } as const),
  ]);
  if (list.status === "not-found") notFound();
  if (list.status !== "ok" || context.status !== "ok" || members.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  // "Today" where the list lives, for the schedule preview: the Home's timezone, or the person's.
  const today = zonedParts(new Date().toISOString(), home?.timeZone ?? formats.timeZone).date;

  return (
    <>
      <ShoppingLive
        contextId={signalContextId(homeId, userId)}
        version={context.value.signalVersion}
      />
      <p className="mb-2">
        <Link
          href={shoppingPath(homeId)}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToLists")}
        </Link>
      </p>
      <PageHeader title={list.value.name} />
      <ShoppingListView
        list={list.value}
        homeId={homeId}
        members={members.value.map(({ id, name, isSelf }) => ({ id, name, isSelf }))}
        formats={formats}
        today={today}
      />
    </>
  );
}
