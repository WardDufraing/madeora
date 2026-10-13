"use client";

import { CloseIcon, MenuIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import { NavLink } from "./nav-link";
import { isActive, primaryNav, secondaryNav, type NavItem } from "./nav-items";

/**
 * Navigation below the `md` breakpoint: a menu button that opens a drawer on the native
 * `<dialog>`, which traps focus, makes the page inert and handles Escape. Designed for small
 * screens rather than squeezing the desktop sidebar (spec).
 */
export function MobileNav() {
  const t = useTranslations("Shell");
  const tNav = useTranslations("Nav");
  const tComponents = useTranslations("Components");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) {
      element.close();
      button.current?.focus();
    }
  }, [open]);

  // Any navigation closes the menu, including the browser's back button. Adjusted during
  // render rather than in an effect, so there is no extra render with the menu still open.
  const [shownPath, setShownPath] = useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    setOpen(false);
  }

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    setOpen(false);
  }

  const renderItems = (items: readonly NavItem[]) => (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.id}>
          <NavLink
            item={item}
            label={tNav(item.id)}
            active={isActive(item.href, pathname)}
            onNavigate={() => {
              setOpen(false);
            }}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-label={t("openMenu")}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg md:hidden"
      >
        <MenuIcon />
      </button>
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
            className="flex min-h-0 flex-1 flex-col justify-between gap-6 overflow-y-auto"
          >
            {renderItems(primaryNav)}
            {renderItems(secondaryNav)}
          </nav>
        </div>
      </dialog>
    </>
  );
}
