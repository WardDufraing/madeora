import type { EnvSource } from "./core.ts";

/**
 * Settings that Vercel preview deployments may fill in for themselves (architecture.md §20, §26).
 *
 * Each preview has its own web address, so `NEXT_PUBLIC_APP_URL` cannot be one fixed value in the
 * Vercel project. On a plain preview only (`VERCEL_ENV=preview` and, when Vercel sets it,
 * `VERCEL_TARGET_ENV=preview`), a missing `APP_ENV` becomes `preview` and a missing
 * `NEXT_PUBLIC_APP_URL` becomes the deployment's `*.vercel.app` branch URL. Values that are already
 * set are never replaced. Every other environment, production and any custom (staging)
 * environment included, gets nothing here, so a missing value there still fails validation.
 * A staging setup on a preview branch must therefore set both values itself.
 */
export function vercelPreviewDefaults(source: EnvSource): Record<string, string> {
  if (source.VERCEL_ENV !== "preview") return {};
  if (source.VERCEL_TARGET_ENV && source.VERCEL_TARGET_ENV !== "preview") return {};

  const defaults: Record<string, string> = {};
  if (!source.APP_ENV) defaults.APP_ENV = "preview";

  const host = source.VERCEL_BRANCH_URL;
  if (!source.NEXT_PUBLIC_APP_URL && host && VERCEL_APP_HOST.test(host)) {
    defaults.NEXT_PUBLIC_APP_URL = `https://${host}`;
  }
  return defaults;
}

/** A bare `*.vercel.app` host such as `madeora-git-feat-x-ward.vercel.app`: no scheme, port or path. */
const VERCEL_APP_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/i;

/** Copies the preview defaults into `env` (normally `process.env`) and returns what was added. */
export function applyVercelPreviewDefaults(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const defaults = vercelPreviewDefaults(env);
  Object.assign(env, defaults);
  return defaults;
}
