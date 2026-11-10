import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, json, readPrivacyMutation } from "@/privacy/route-helpers";
import { getStorage } from "@/storage/server";

interface DownloadRouteContext {
  readonly params: Promise<{ readonly exportId: string }>;
}

/** Long enough for the browser to start the download, short enough that a copied link dies. */
const DOWNLOAD_LINK_SECONDS = 60;

/**
 * Gives the signed-in person a 60-second GET-only link to their own ready export (S39, spec
 * "Confirmed generated export expiration"). A POST, so a cross-site page cannot trigger it. The
 * database checks again, on every download, that the export is theirs, ready and unexpired, that
 * this session is live with a fresh re-authentication, and that nothing it depended on changed
 * (Home memberships in scope, account state); if something did, the export is invalidated and its
 * file removed, and the person is asked for a fresh export. The link never reaches an email or a
 * log, carries a neutral filename and is never cached.
 */
export async function POST(request: Request, { params }: DownloadRouteContext): Promise<Response> {
  const input = await readPrivacyMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const { exportId } = await params;
  if (!z.uuid().safeParse(exportId).success) return failure(404, "not-found");
  const storage = getStorage();
  if (!storage) return failure(503, "storage-off");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("authorize_export_download", {
    p_export_id: exportId,
  });
  if (error) return databaseFailure("privacy.export_download_failed", error);
  const row = data[0];
  // No key: the export was invalidated just now because access changed since it was prepared.
  if (!row?.object_key || !row.generated_at) return failure(410, "invalidated");

  const day = row.generated_at.slice(0, 10);
  const url = storage.objects.presignGet(row.object_key, {
    expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    contentType: "application/zip",
    disposition: "attachment",
    filename: `madeora-export-${day}.zip`,
  });
  return json(200, { url });
}
