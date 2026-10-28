import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { getShoppingList } from "@/shopping/data";
import { shoppingListPath, shoppingRights } from "@/shopping/format";

import { AddSeveral } from "./add-several";

/** Add several items to one list (S26): for its editors while it is active. */
export async function AddSeveralPage({
  listId,
  homeId,
}: {
  readonly listId: string;
  readonly homeId: string | null;
}) {
  const [t, list] = await Promise.all([
    getTranslations("Shopping"),
    getShoppingList(listId, homeId),
  ]);
  if (list.status === "not-found") notFound();
  if (list.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const back = (
    <p className="mb-2">
      <Link
        href={shoppingListPath(homeId, listId)}
        className="text-body font-medium text-accent-fg underline"
      >
        {t("backToList", { name: list.value.name })}
      </Link>
    </p>
  );
  if (!shoppingRights(list.value).edit) {
    return (
      <>
        {back}
        <ErrorState title={t("addSeveralTitle")} description={t("failureNotPermitted")} />
      </>
    );
  }
  return (
    <>
      {back}
      <PageHeader title={t("addSeveralTitle")} />
      <AddSeveral
        listId={listId}
        homeId={homeId}
        activeNames={list.value.items
          .filter((item) => item.completedAt === null)
          .map((item) => item.name)}
      />
    </>
  );
}
