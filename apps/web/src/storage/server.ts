import "server-only";

import { getPublicEnv } from "@madeora/config/env/public";
import type { Database } from "@madeora/database";
import { createObjectStore, type ObjectStore } from "@madeora/storage";
import { createClient } from "@supabase/supabase-js";

import { parseWebStorageSettings } from "./config";

export type FinalizeOutcome = "ready" | "not_found" | "expired" | "invalid" | "storage_full";

/** The one privileged call the web app makes (ADR 0019). */
export interface UploadFinalizer {
  finalize(
    userId: string,
    fileId: string,
    facts: { readonly contentType: string; readonly size: number; readonly sha256: string },
  ): Promise<FinalizeOutcome>;
}

export interface Storage {
  readonly objects: ObjectStore;
  readonly finalizer: UploadFinalizer;
}

const outcomes: readonly FinalizeOutcome[] = [
  "ready",
  "not_found",
  "expired",
  "invalid",
  "storage_full",
];

let cached: { readonly storage: Storage | null } | undefined;

/**
 * The object store and the finalizer, or null where storage is off (S15). Built on first use.
 *
 * The finalizer holds the Supabase secret key but can do exactly one thing: call
 * `public.finalize_upload` for the signed-in person whose identity the route verified. The
 * database function re-checks that the upload is theirs, pending and unexpired, and that the pool
 * has room; nothing else in the web app uses this key, and every other call runs as the person.
 */
export function getStorage(): Storage | null {
  if (cached) return cached.storage;
  const settings = parseWebStorageSettings(process.env);
  if (!settings) {
    cached = { storage: null };
    return null;
  }
  const service = createClient<Database>(
    getPublicEnv().NEXT_PUBLIC_SUPABASE_URL,
    settings.serviceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const storage: Storage = {
    objects: createObjectStore(settings.store),
    finalizer: {
      async finalize(userId, fileId, facts) {
        const { data, error } = await service.rpc("finalize_upload", {
          p_user_id: userId,
          p_file_id: fileId,
          p_content_type: facts.contentType,
          p_size: facts.size,
          p_sha256: facts.sha256,
        });
        if (error) throw new Error(`finalize_upload failed: ${error.code}`);
        const outcome = outcomes.find((value) => value === data);
        if (!outcome) throw new Error("finalize_upload: unexpected result");
        return outcome;
      },
    },
  };
  cached = { storage };
  return storage;
}

/** Whether uploads are possible here, for pages deciding whether to show upload controls. */
export function storageEnabled(): boolean {
  try {
    return getStorage() !== null;
  } catch (error) {
    // Startup validation reports the variable names; this only notes that pages hid uploads.
    console.error(
      JSON.stringify({
        event: "storage.config_invalid",
        code: error instanceof Error ? error.name : "unknown",
      }),
    );
    return false;
  }
}
