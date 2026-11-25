"use client";

import { ChoresIcon, DashboardIcon, ShoppingIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";

import { Dialog } from "@/components/ui/dialog";

/** Where the wall display can go (UX8b, decision 38): only what its board already carries. */
export const DISPLAY_VIEWS = ["dashboard", "chores", "shopping"] as const;
export type DisplayView = (typeof DISPLAY_VIEWS)[number];

const ICONS: Record<DisplayView, typeof DashboardIcon> = {
  dashboard: DashboardIcon,
  chores: ChoresIcon,
  shopping: ShoppingIcon,
};

/**
 * The wall display's expandable menu (UX8b, decision 38): a spacious, touch-friendly list of the
 * places this display can show, opened from the always-visible Menu control. It marks where the
 * display is now, opens a place directly and closes; Escape and the close button close it and
 * focus returns to the Menu control. Labels use the app's module names (Nav) so a module is called
 * the same on the wall and on a phone. It shows no previews, so nothing restricted can leak here.
 */
export function DisplayMenu({
  open,
  current,
  onClose,
  onSelect,
}: {
  readonly open: boolean;
  readonly current: DisplayView;
  readonly onClose: () => void;
  readonly onSelect: (view: DisplayView) => void;
}) {
  const t = useTranslations("DisplayBoard");
  const tNav = useTranslations("Nav");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("menuTitle")}
      description={t("menuDescription")}
      closeLabel={t("close")}
      size="large"
    >
      <nav aria-label={t("menu")} data-testid="display-menu">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {DISPLAY_VIEWS.map((view) => {
            const Icon = ICONS[view];
            const active = view === current;
            return (
              <li key={view}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-24 w-full flex-col items-center justify-center gap-3 rounded-card border px-4 py-5 text-center text-section-title font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                    active
                      ? "border-accent bg-accent-subtle text-fg shadow-inset"
                      : "border-line-control bg-surface text-fg shadow-raised hover:bg-accent-subtle"
                  }`}
                  data-testid={`display-menu-${view}`}
                  onClick={() => {
                    onSelect(view);
                  }}
                >
                  <Icon size="lg" />
                  <span>{tNav(view)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </Dialog>
  );
}
