import type { LabelColor } from "@/tasks/schema";

/**
 * A task label: always its name as text, with an optional colour dot beside it (spec: never colour
 * alone; text keeps the theme's contrast because only the dot is coloured).
 */
export function LabelChip({
  name,
  color,
}: {
  readonly name: string;
  readonly color: LabelColor | null;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-helper text-fg">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full border border-line-control"
        style={color ? { backgroundColor: `var(--md-color-palette-${color})` } : undefined}
      />
      <bdi className="truncate">{name}</bdi>
    </span>
  );
}
