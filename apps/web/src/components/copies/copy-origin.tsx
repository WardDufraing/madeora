import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { getCopyOrigin } from "@/copies/server";
import type { CopyItemType } from "@/copies/catalogue";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

/**
 * The quiet origin label of a Home item copied from someone's personal item (S40 part 2, spec
 * "Confirmed origin metadata for independent Home-owned copies"): "Copied from personal", with the
 * date in a details disclosure. No link, no source, no person; nothing for any other item.
 */
export async function CopyOrigin({
  type,
  id,
}: {
  readonly type: CopyItemType | "photo";
  readonly id: string;
}) {
  const at = await getCopyOrigin(type, id);
  if (!at) return null;
  const [t, formats] = await Promise.all([getTranslations("HomeCopies"), getDateTimeFormats()]);
  return (
    <details className="text-helper text-fg-muted" data-testid="copy-origin">
      <summary className="cursor-pointer">{t("originLabel")}</summary>
      <p className="mt-1">{t("originDetails", { date: formatDateTime(at, formats) })}</p>
    </details>
  );
}

/** The item action that opens the copy page (personal items only; the database checks again). */
export async function CopyToHomeLink({
  href,
  className = "text-body font-medium text-accent-fg underline",
}: {
  readonly href: string;
  readonly className?: string;
}) {
  const t = await getTranslations("HomeCopies");
  return (
    <Link href={href} className={className} data-testid="copy-to-home-link">
      {t("itemAction")}
    </Link>
  );
}
