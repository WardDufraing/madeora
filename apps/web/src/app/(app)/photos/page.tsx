import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { PhotosPage } from "@/components/photos/photos-page";
import { pageTitle } from "@/i18n/page-title";
import { PHOTO_LIMITS } from "@/photos/schema";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Photos");
  return { title: await pageTitle(t("title")) };
}

/** The person's personal photo library (S35); `?album=` opens one album, `?offset=` a later page. */
export default async function PersonalPhotosPage({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  const query = await searchParams;
  const album = z.uuid().safeParse(query.album);
  const offset = z.coerce.number().int().min(0).max(PHOTO_LIMITS.maxOffset).safeParse(query.offset);
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <PhotosPage
        home={null}
        albumId={album.success ? album.data : null}
        offset={offset.success ? offset.data : 0}
      />
    </>
  );
}
