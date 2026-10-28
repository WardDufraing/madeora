import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ShoppingListPage } from "@/components/shopping/shopping-list-page";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getShoppingList } from "@/shopping/data";
import { pathId } from "@/shopping/route-helpers";

interface HomeListPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly listId: string }>;
}

export async function generateMetadata({ params }: HomeListPageProps): Promise<Metadata> {
  const { homeId, listId } = await params;
  const found = await getHomeContext(homeId);
  const id = pathId(listId);
  const tHomes = await getTranslations("Homes");
  if (found.status !== "ok" || !id) return { title: await pageTitle(tHomes("homeFallbackTitle")) };
  const list = await getShoppingList(id, found.context.home.id);
  const t = await getTranslations("Shopping");
  return {
    title: await pageTitle(
      list.status === "ok"
        ? list.value.name
        : t("homePageTitle", { home: found.context.home.name }),
    ),
  };
}

/** One of a Home's shopping lists (S26), for its current members. */
export default async function HomeListPage({ params }: HomeListPageProps) {
  const { userId } = await requireIdentity();
  const { homeId, listId } = await params;
  const id = pathId(listId);
  if (!id) notFound();
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <ShoppingListPage userId={userId} listId={id} home={context.home} />
    </>
  );
}
