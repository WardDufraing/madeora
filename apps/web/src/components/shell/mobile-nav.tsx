"use client";

import { CloseIcon, MenuIcon, ModulesIcon, PlusIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";

import { useFavorites } from "./favorites";
import { NavLink } from "./nav-link";
import {
  contextHref,
  coreNav,
  createHref,
  homeIdFromPath,
  isActive,
  isItemActive,
  modulesHref,
  moduleNav,
  secondaryNav,
  type NavItem,
} from "./nav-items";
import { useScrollHide } from "./use-scroll-hide";

const tabClass =
  "group relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-control px-0.5 text-helper";

/**
 * Navigation below the `md` breakpoint (redesign decisions 26, 27 and 29): a bottom bar with
 * Dashboard, Calendar, a central Create action, Tasks and More. More opens the full menu with
 * every destination on the native `<dialog>`, which traps focus, makes the page inert and handles
 * Escape. The bar hides while scrolling down and returns on scrolling up, at the top of the page,
 * when focus is inside it and while a menu is open. The workspace switcher lives in the top bar.
 */
export function MobileNav() {
  const t = useTranslations("Shell");
  const tNav = useTranslations("Nav");
  const tComponents = useTranslations("Components");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const hidden = useScrollHide(open || createOpen || focusInside);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) {
      element.close();
      button.current?.focus();
    }
  }, [open]);

  // Any navigation closes the menus, including the browser's back button. Adjusted during
  // render rather than in an effect, so there is no extra render with a menu still open.
  const [shownPath, setShownPath] = useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    setOpen(false);
    setCreateOpen(false);
  }

  // A click on the backdrop lands on the dialog element itself; inside the panel it lands on its
  // contents. Pointer-only, because keyboard users have Escape and the Close button.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    function closeOnBackdrop(event: MouseEvent) {
      if (event.target === element) setOpen(false);
    }
    element.addEventListener("click", closeOnBackdrop);
    return () => {
      element.removeEventListener("click", closeOnBackdrop);
    };
  }, []);

  // The menus are for small screens only. If the window grows past the breakpoint while one is
  // open, the sidebar takes over and the menu closes, so the page is not left inert.
  useEffect(() => {
    if (!open && !createOpen) return;
    const wide = window.matchMedia("(min-width: 48rem)");
    function closeIfWide() {
      if (wide.matches) {
        setOpen(false);
        setCreateOpen(false);
      }
    }
    closeIfWide();
    wide.addEventListener("change", closeIfWide);
    return () => {
      wide.removeEventListener("change", closeIfWide);
    };
  }, [open, createOpen]);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    setOpen(false);
  }

  const homeId = homeIdFromPath(pathname);
  const shortcutsId = useId();
  const { pinned } = useFavorites();
  const shortcuts = pinned
    .map((id) => moduleNav.find((item) => item.id === id))
    .filter((item): item is NavItem => item !== undefined);
  const modulesLink = modulesHref(homeId);
  const renderItems = (items: readonly NavItem[]) => (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.id}>
          <NavLink
            item={item}
            href={contextHref(item, homeId)}
            label={tNav(item.id)}
            active={isItemActive(item, homeId, pathname)}
            onNavigate={() => {
              setOpen(false);
            }}
          />
        </li>
      ))}
    </ul>
  );

  const createEntries = [
    { id: "task", label: t("createTask"), href: createHref("task", homeId) },
    { id: "event", label: t("createEvent"), href: createHref("event", homeId) },
    { id: "shopping", label: t("createShoppingItem"), href: createHref("shopping", homeId) },
  ] as const;

  const [dashboard, calendar, tasks] = coreNav;
  const tabs = (items: readonly (NavItem | undefined)[]) =>
    items.map((item) => {
      if (!item) return null;
      const Icon = item.icon;
      const active = isItemActive(item, homeId, pathname);
      return (
        <li key={item.id} className="flex min-w-0 flex-1">
          <Link
            href={contextHref(item, homeId)}
            aria-current={active ? "page" : undefined}
            className={cx(tabClass, active ? "font-semibold text-fg" : "text-fg-muted")}
          >
            {/* The current tab sits in a soft pill, and is also bolder: never colour alone. */}
            <span
              aria-hidden="true"
              className={cx(
                "inline-flex h-8 w-full max-w-14 items-center justify-center rounded-pill group-hover:bg-accent-subtle motion-safe:transition-colors",
                active &&
                  "border border-transparent bg-accent-subtle forced-colors:border-[Highlight]",
              )}
            >
              <Icon size="md" />
            </span>
            <span className="max-w-full truncate">{tNav(item.id)}</span>
          </Link>
        </li>
      );
    });

  return (
    <>
      <nav
        aria-label={t("bottomNavigation")}
        data-hidden={hidden}
        onFocusCapture={() => {
          setFocusInside(true);
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
        }}
        className={cx(
          "fixed inset-x-0 bottom-0 z-30 border-t border-line bg-sidebar pb-[env(safe-area-inset-bottom)] shadow-overlay md:hidden",
          "transition-transform duration-(--md-duration-base) ease-standard",
          hidden && "translate-y-full",
        )}
      >
        <ul className="mx-auto flex max-w-xl items-stretch px-1 pt-1 min-[360px]:gap-1 min-[360px]:px-2">
          {tabs([dashboard, calendar])}
          <li className="flex flex-none items-center justify-center px-1">
            <button
              type="button"
              onClick={() => {
                setCreateOpen(true);
              }}
              aria-haspopup="dialog"
              className="inline-flex min-h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-control bg-accent px-2 text-helper font-semibold text-on-accent shadow-raised hover:bg-accent-hover active:bg-accent-pressed"
            >
              <PlusIcon size="md" />
              <span>{t("createMenu")}</span>
            </button>
          </li>
          {tabs([tasks])}
          <li className="flex min-w-0 flex-1">
            <button
              ref={button}
              type="button"
              onClick={() => {
                setOpen(true);
              }}
              aria-haspopup="dialog"
              className={cx(tabClass, "text-fg-muted")}
            >
              <span
                aria-hidden="true"
                className="inline-flex h-8 w-full max-w-14 items-center justify-center rounded-pill group-hover:bg-accent-subtle"
              >
                <MenuIcon size="md" />
              </span>
              <span className="max-w-full truncate">{t("moreMenu")}</span>
            </button>
          </li>
        </ul>
      </nav>
      <Dialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        title={t("createMenuTitle")}
        closeLabel={t("closeCreateMenu")}
        size="sheet"
      >
        <ul className="flex flex-col gap-1">
          {createEntries.map((entry) => (
            <li key={entry.id}>
              <Link
                href={entry.href}
                className="flex min-h-12 items-center gap-3 rounded-control px-3 text-body font-medium text-fg hover:bg-accent-subtle"
              >
                <PlusIcon size="md" className="text-fg-muted" />
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </Dialog>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={handleCancel}
        onClose={() => {
          setOpen(false);
        }}
        className="m-0 h-dvh max-h-dvh w-72 max-w-[calc(100vw-3rem)] border-e border-line bg-sidebar p-0 text-fg shadow-overlay backdrop:bg-overlay open:animate-enter"
      >
        <div className="flex h-full flex-col gap-4 p-3">
          <div className="flex items-center justify-between gap-2 ps-3">
            <h2 id={titleId} className="text-section-title font-semibold">
              {t("menuTitle")}
            </h2>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
              }}
              aria-label={tComponents("close")}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
            >
              <CloseIcon />
            </button>
          </div>
          <nav
            aria-label={t("mainNavigation")}
            className="flex min-h-0 flex-1 flex-col justify-between gap-6 overflow-y-auto p-1"
          >
            <div className="flex flex-col gap-4">
              {renderItems(coreNav)}
              {shortcuts.length > 0 ? (
                <section aria-labelledby={shortcutsId} className="flex flex-col gap-1">
                  <h3
                    id={shortcutsId}
                    className="px-3 text-helper font-semibold tracking-wide text-fg-muted uppercase"
                  >
                    {t("shortcuts")}
                  </h3>
                  {renderItems(shortcuts)}
                </section>
              ) : null}
              <ul className="flex flex-col gap-1">
                <li>
                  <NavLink
                    item={{ icon: ModulesIcon }}
                    href={modulesLink}
                    label={t("allModules")}
                    active={isActive(modulesLink, pathname)}
                    onNavigate={() => {
                      setOpen(false);
                    }}
                  />
                </li>
              </ul>
            </div>
            {renderItems(secondaryNav)}
          </nav>
        </div>
      </dialog>
    </>
  );
}
