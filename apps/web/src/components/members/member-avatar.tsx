import { accentFill, DEFAULT_ACCENT, type AccentColor } from "@/accent/accent";
import { cx } from "@/components/ui/cx";
import { initials } from "@/members/initials";
import { fileContentPath } from "@/storage/api";

export interface MemberAvatarProps {
  /** The effective name in this context, or `null` for none. */
  readonly name: string | null;
  /** The member's effective colour, or `null` for the default accent. */
  readonly accentColor: AccentColor | null;
  readonly locale: string;
  /** The member's effective avatar picture (S15), or `null`/absent for initials only. */
  readonly avatarFileId?: string | null;
  readonly size?: "md" | "lg";
  readonly className?: string;
}

/**
 * A member's avatar (S11): their picture (S15) when they have one, over their initials on their
 * identifying colour, or a neutral dot for a member without a name. The picture is loaded through
 * the authorizing content route, so every view is checked again; if it cannot load, the initials
 * underneath stay visible. Decorative: the name next to it is what identifies the person, so it is
 * hidden from screen readers and never carries meaning by colour alone. The fill is the readable
 * version of the colour (`deriveAccent`), with an outline so a very light or very dark colour keeps
 * its shape on every surface. The colour is the member's own choice, not a design token
 * (`data-member-colour` lets the token-colour checks tell the two apart).
 */
export function MemberAvatar({
  name,
  accentColor,
  locale,
  avatarFileId = null,
  size = "md",
  className,
}: MemberAvatarProps) {
  const { fill, onFill } = accentFill(accentColor ?? DEFAULT_ACCENT);
  const letters = initials(name, locale);
  return (
    <span
      aria-hidden="true"
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-line-control font-semibold select-none",
        size === "lg" ? "size-14 text-section-title" : "size-10 text-body",
        className,
      )}
      style={{ backgroundColor: fill, color: onFill }}
      data-member-colour=""
      data-testid="member-avatar"
    >
      {letters ?? "\u{2022}"}
      {avatarFileId ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private, per-viewer authorized redirect; next/image would cache it for everyone
        <img
          src={fileContentPath(avatarFileId)}
          alt=""
          width={size === "lg" ? 56 : 40}
          height={size === "lg" ? 56 : 40}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full object-cover"
          data-testid="member-avatar-image"
        />
      ) : null}
    </span>
  );
}
