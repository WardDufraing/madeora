import Link from "next/link";

export interface BrandProps {
  /** Accessible name of the link, for example "Madeora, go to the dashboard". */
  readonly label: string;
  readonly showWordmark: boolean;
}

/**
 * Placeholder mark and wordmark. The Madeora brand mark and its fixed colour are still open
 * (docs/design/design-decisions.md), so this is a neutral letter that does not follow the accent.
 */
export function Brand({ label, showWordmark }: BrandProps) {
  return (
    <Link
      href="/"
      aria-label={label}
      className="flex h-10 min-w-0 items-center gap-3 rounded-control text-section-title font-semibold text-fg"
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-control bg-fg text-body font-bold text-page"
      >
        M
      </span>
      {showWordmark ? (
        <span aria-hidden="true" className="truncate">
          Madeora
        </span>
      ) : null}
    </Link>
  );
}
