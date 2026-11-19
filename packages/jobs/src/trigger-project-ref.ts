/**
 * Which Trigger.dev project `trigger.config.ts` deploys to (S13).
 * The production ref is not a secret. A blank `TRIGGER_PROJECT_REF` keeps it, so a production
 * deploy that does not set the variable is unchanged. A non-blank value selects another project
 * (the free preview project, `docs/trigger-setup.md`).
 */

/** Production Trigger.dev project. Used when `TRIGGER_PROJECT_REF` is unset or blank. */
export const PRODUCTION_TRIGGER_PROJECT_REF = "proj_yhkmlscenxkikqvgfnvs";

const PROJECT_REF = /^proj_[a-z0-9]{10,40}$/;

/**
 * Resolves the project ref. Unset, empty, and whitespace-only values keep the production project.
 * Any other value must already be a Trigger.dev project ref (`proj_…`); surrounding spaces are ignored.
 */
export function resolveTriggerProjectRef(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return PRODUCTION_TRIGGER_PROJECT_REF;
  if (!PROJECT_REF.test(trimmed)) {
    throw new Error(
      "TRIGGER_PROJECT_REF must be a Trigger.dev project ref (proj_...), see docs/trigger-setup.md",
    );
  }
  return trimmed;
}
