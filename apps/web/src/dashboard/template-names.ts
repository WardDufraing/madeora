import "server-only";

import { listTemplates } from "./server";

/**
 * Whether `name` is already used by another of the person's own templates (UX2c; redesign decision
 * 31, clear preset names), ignoring case and surrounding spaces, across both kinds. `null` when the
 * templates could not be read. Two requests at the same moment can still both pass: names are a
 * clarity rule, not an identity, and the database keeps accepting older duplicates.
 */
export async function templateNameTaken(
  name: string,
  exceptId: string | null = null,
): Promise<boolean | null> {
  const visible = await listTemplates(null);
  if (visible.status !== "ok") return null;
  const wanted = name.trim().toLocaleLowerCase();
  return visible.templates.some(
    (template) =>
      template.isMine &&
      template.id !== exceptId &&
      template.name.trim().toLocaleLowerCase() === wanted,
  );
}
