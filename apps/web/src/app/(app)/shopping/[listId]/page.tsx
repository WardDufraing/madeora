import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { ShoppingListPage } from "@/components/shopping/shopping-list-page";
import { pageTitle } from "@/i18n/page-title";
import { getShoppingList } from "@/shopping/data";
import { pathId } from "@/shopping/route-helpers";

interface PersonalListPageProps {
  readonly params: Promise<{ readonly listId: string }>;
}

export async function generateMetadata({ params }: PersonalListPageProps): Promise<Metadata> {
  const listId = pathId((await params).listId);
  const t = await getTranslations("Shopping");
  const list = listId ? await getShoppingList(listId, null) : null;
  return {
    title: await pageTitle(list?.status === "ok" ? list.value.name : t("personalPageTitle")),
  };
}

/** One of the Personal space's shopping lists (S26). */
export default async function PersonalListPage({ params }: PersonalListPageProps) {
  const { userId } = await requireIdentity();
  const listId = pathId((await params).listId);
  if (!listId) notFound();
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <ShoppingListPage userId={userId} listId={listId} home={null} />
    </>
  );
}
