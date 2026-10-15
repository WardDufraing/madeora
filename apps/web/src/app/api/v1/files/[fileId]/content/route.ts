import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logStorage } from "@/storage/route-helpers";
import { fileIdSchema } from "@/storage/schema";
import { getStorage } from "@/storage/server";

/** Long enough for the browser to follow the redirect, short enough that a copied link dies. */
const DOWNLOAD_LINK_SECONDS = 60;
// Only processed images are ever shown inline; anything else would be a download.
const INLINE_TYPES = new Set(["image/webp"]);

interface FileRouteContext {
  readonly params: Promise<{ readonly fileId: string }>;
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * Shows a stored file to someone allowed to see it now (S15, architecture.md §10 "Download
 * lifecycle"). Every request asks the database again (`authorize_file_read`, with the viewer's own
 * session), so leaving a Home or a changed avatar takes effect at once; then it redirects to a
 * 60-second GET-only link that fixes the type, the disposition and no caching. Every refusal is the
 * same 404, whether the file does not exist or is not the viewer's to see.
 */
export async function GET(_request: Request, { params }: FileRouteContext): Promise<Response> {
  const fileId = fileIdSchema.safeParse((await params).fileId);
  if (!fileId.success) return notFound();
  if (!(await getVerifiedIdentity())) {
    return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const storage = getStorage();
  if (!storage) return notFound();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("authorize_file_read", { p_file_id: fileId.data });
  // An unconfirmed or ended session: the same answer as signed out.
  if (error?.code === "42501") {
    return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (error) {
    logStorage("storage.read_authorize_failed", error.code);
    return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  const file = data[0];
  if (!file) return notFound();

  const location = storage.objects.presignGet(file.object_key, {
    expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    contentType: file.content_type,
    disposition: INLINE_TYPES.has(file.content_type) ? "inline" : "attachment",
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
