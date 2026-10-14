import { accentFill, DEFAULT_ACCENT, type AccentColor } from "@/accent/accent";
import { cx } from "@/components/ui/cx";
import { initials } from "@/members/initials";

export interface MemberAvatarProps {
  /** The effective name in this context, or `null` for none. */
  readonly name: string | null;
  /** The member's effective colour, or `null` for the default accent. */
  readonly accentColor: AccentColor | null;
  readonly locale: string;
  readonly size?: "md" | "lg";
  readonly className?: string;
}

/**
 * A member's avatar (S11): their initials on their identifying colour, or a neutral dot for a
 * member without a name. Image avatars arrive with file storage (S15). Decorative: the name next
 * to it is what identifies the person, so it is hidden from screen readers and never carries
 * meaning by colour alone. The fill is the readable version of the colour (`deriveAccent`), with
 * an outline so a very light or very dark colour keeps its shape on every surface.
 */
export function MemberAvatar({
  name,
  accentColor,
  locale,
  size = "md",
  className,
}: MemberAvatarProps) {
  const { fill, onFill } = accentFill(accentColor ?? DEFAULT_ACCENT);
  const letters = initials(name, locale);
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-line-control font-semibold select-none",
        size === "lg" ? "size-14 text-section-title" : "size-10 text-body",
        className,
      )}
      style={{ backgroundColor: fill, color: onFill }}
      data-testid="member-avatar"
    >
      {letters ?? "\u{2022}"}
    </span>
  );
}
