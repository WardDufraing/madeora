/**
 * Storage settings (S15, architecture.md §10, §20). The same variables configure the web app's
 * server (signing upload and download links, finalizing) and the Trigger.dev jobs (deleting
 * objects). Unset `STORAGE_DRIVER` means `off`: no file can be uploaded, and the app says so.
 *
 * The values are secrets except the endpoint, region and bucket. Validation names a variable,
 * never its value.
 */
import { parseEnv, type EnvSource } from "@madeora/config/env";
import { z } from "zod";

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export const storageEnvSchema = z
  .object({
    /** `s3` (Cloudflare R2, or any S3-compatible service) or `off` (the default). */
    STORAGE_DRIVER: z.enum(["s3", "off"]).optional(),
    /** The S3 API address, for R2 `https://<account id>.r2.cloudflarestorage.com`. */
    STORAGE_S3_ENDPOINT: z
      .url({ protocol: /^https?$/ })
      .refine((value) => !new URL(value).search && !new URL(value).hash, "no query or fragment")
      .optional(),
    /** `auto` for R2. */
    STORAGE_S3_REGION: z
      .string()
      .regex(/^[a-z0-9-]{2,32}$/)
      .optional(),
    STORAGE_S3_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .optional(),
    /** Secret: the access key id of a token limited to this bucket. */
    STORAGE_S3_ACCESS_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9]{16,128}$/)
      .optional(),
    /** Secret: its secret access key. */
    STORAGE_S3_SECRET_ACCESS_KEY: z
      .string()
      .regex(/^[A-Za-z0-9/+=]{20,128}$/)
      .optional(),
  })
  .superRefine((env, context) => {
    if (env.STORAGE_DRIVER !== "s3") return;
    for (const variable of [
      "STORAGE_S3_ENDPOINT",
      "STORAGE_S3_BUCKET",
      "STORAGE_S3_ACCESS_KEY_ID",
      "STORAGE_S3_SECRET_ACCESS_KEY",
    ] as const) {
      if (!env[variable]) {
        context.addIssue({ code: "custom", path: [variable], message: `${variable} is required` });
      }
    }
    // Plain http only to this machine (the local S3 stand-in).
    if (env.STORAGE_S3_ENDPOINT) {
      const url = new URL(env.STORAGE_S3_ENDPOINT);
      if (url.protocol === "http:" && !LOCAL_HOSTS.includes(url.hostname)) {
        context.addIssue({
          code: "custom",
          path: ["STORAGE_S3_ENDPOINT"],
          message: "STORAGE_S3_ENDPOINT must be https unless it is on this machine",
        });
      }
    }
  });

export type StorageEnv = z.infer<typeof storageEnvSchema>;

/** The settings an object store needs; null when storage is off. */
export interface StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Throws EnvValidationError naming missing or invalid variables, never their values. */
export function parseStorageEnv(source: EnvSource): StorageEnv {
  return parseEnv(storageEnvSchema, source);
}

export function storageConfigFromEnv(env: StorageEnv): StorageConfig | null {
  if (
    env.STORAGE_DRIVER !== "s3" ||
    !env.STORAGE_S3_ENDPOINT ||
    !env.STORAGE_S3_BUCKET ||
    !env.STORAGE_S3_ACCESS_KEY_ID ||
    !env.STORAGE_S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  return {
    endpoint: env.STORAGE_S3_ENDPOINT.replace(/\/+$/, ""),
    region: env.STORAGE_S3_REGION ?? "auto",
    bucket: env.STORAGE_S3_BUCKET,
    accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
  };
}
