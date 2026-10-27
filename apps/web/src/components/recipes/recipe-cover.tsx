import { MealsIcon } from "@madeora/icons";

import { cx } from "@/components/ui/cx";
import { fileContentPath } from "@/storage/api";

export interface RecipeCoverProps {
  readonly fileId: string | null;
  /** `card`: a fixed 4:3 thumbnail; `hero`: the detail page's wide image. */
  readonly size: "card" | "hero";
  readonly className?: string;
}

/**
 * A recipe's cover photo, or a neutral placeholder without one (S24). Decorative: the recipe's
 * name is always beside it, so the image has empty alternative text. The file is read through the
 * authorizing content route, which answers only to whoever may see the recipe now.
 */
export function RecipeCover({ fileId, size, className }: RecipeCoverProps) {
  const frame = cx(
    "overflow-hidden rounded-card bg-surface-sunken",
    size === "card" ? "aspect-[4/3] w-full" : "aspect-[16/9] w-full max-h-96",
    className,
  );
  if (!fileId) {
    return (
      <div className={cx(frame, "flex items-center justify-center text-fg-muted")}>
        <MealsIcon aria-hidden="true" className={size === "card" ? "size-8" : "size-12"} />
      </div>
    );
  }
  return (
    <div className={frame}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, per-viewer authorized redirect; next/image would cache it for everyone */}
      <img
        src={fileContentPath(fileId)}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
    </div>
  );
}
