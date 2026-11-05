import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pathId } from "@/photos/route-helpers";
import { photoVariantSchema } from "@/photos/schema";
import { logStorage } from "@/storage/route-helpers";
import { getStorage } from "@/storage/server";

/** Long enough for the browser to follow the redirect, short enough that a copied link dies. */
const DOWNLOAD_LINK_SECONDS = 60;

interface PhotoRouteContext {
  readonly params: Promise<{ readonly photoId: string }>;
}

function status(code: number): Response {
  return new Response(null, { status: code, headers: { "Cache-Control": "no-store" } });
}

/**
 * Shows one picture of a photo (`?variant=thumb|display|full|master`) to someone allowed to see it
 * now (S35, architecture.md §10 "Download lifecycle"). Every request asks the database again
 * (`authorize_photo_read`, with the viewer's own session), so leaving a Home or deleting the photo
 * takes effect at once; then it redirects to a 60-second GET-only link. Every refusal is the same
 * 404, whether the photo does not exist or is not the viewer's to see.
 */
export async function GET(request: Request, { params }: PhotoRouteContext): Promise<Response> {
  const photoId = pathId((await params).photoId);
  const variant = photoVariantSchema.safeParse(new URL(request.url).searchParams.get("variant"));
  if (!photoId || !variant.success) return status(404);
  if (!(await getVerifiedIdentity())) return status(401);
  const storage = getStorage();
  if (!storage) return status(404);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("authorize_photo_read", {
    p_photo_id: photoId,
    p_variant: variant.data,
  });
  if (error?.code === "42501") return status(401);
  if (error) {
    logStorage("photos.read_authorize_failed", error.code);
    return status(500);
  }
  const file = data[0];
  if (!file) return status(404);

  const location = storage.objects.presignGet(file.object_key, {
    expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    contentType: file.content_type,
    disposition:
      new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
