import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireIdentity } from "@/auth/identity";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { PhotosPage } from "@/components/photos/photos-page";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { PHOTO_LIMITS } from "@/photos/schema";

interface PageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Photos"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("homeTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/** The photo library of a Home (S35), for its current members. */
export default async function HomePhotosPage({ params, searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const query = await searchParams;
  const album = z.uuid().safeParse(query.album);
  const offset = z.coerce.number().int().min(0).max(PHOTO_LIMITS.maxOffset).safeParse(query.offset);
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <PhotosPage
        home={context.home}
        albumId={album.success ? album.data : null}
        offset={offset.success ? offset.data : 0}
      />
    </>
  );
}
