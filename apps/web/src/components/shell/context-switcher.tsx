"use client";

import { ChevronDownIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { cx } from "@/components/ui/cx";
import type { MyHome } from "@/homes/types";

import { homeIdFromPath } from "./nav-items";
import { useRoleLabel } from "./use-role-label";

export interface ContextSwitcherProps {
  /** The Homes the person belongs to now, sorted; `null` when they could not be loaded. */
  readonly homes: readonly MyHome[] | null;
}

const itemClass =
  "flex min-h-10 w-full items-center justify-between gap-3 rounded-control px-3 text-start text-body text-fg hover:bg-accent-subtle";

/**
 * The explicit context switcher in the top bar (spec "Confirmed explicit multi-Home switching"):
 * names the current context, and opens a list with Personal, every Home the person belongs to now
 * (with their role there), Create a Home and Join a Home. A disclosure with plain links rather
 * than an ARIA menu, so it works the same with a keyboard, a screen reader and touch.
 *
 * The context is the URL (`/homes/{id}/...` or a personal page), never this component's state, so
 * two tabs can be in different Homes. Every Home page checks the membership on the server; this
 * list only offers what the server listed when the page was loaded.
 */
export function ContextSwitcher({ homes }: ContextSwitcherProps) {
  const t = useTranslations("Shell");
  const roleLabel = useRoleLabel();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const homeId = homeIdFromPath(pathname);
  const current = homeId === null ? null : (homes?.find((home) => home.id === homeId) ?? null);

  // Any navigation closes the list. Adjusted during render, as in MobileNav.
  const [shownPath, setShownPath] = useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    setOpen(false);
  }

  // A Home page this list does not know yet (just created, or joined in another tab): ask the
  // server for the current list once. The layout is not rendered again on navigation by itself.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (homeId === null || homes === null || current !== null) return;
    if (refreshedFor.current === homeId) return;
    refreshedFor.current = homeId;
    router.refresh();
  }, [homeId, homes, current, router]);

  // While open: a pointer press outside closes the list without moving focus, Escape closes it
  // and returns focus to the button, and tabbing out of it closes it, so it never stays open
  // behind the page.
  useEffect(() => {
    if (!open) return;
    const element = container.current;
    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && !element?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    }
    function closeOnFocusLeaving(event: FocusEvent) {
      if (!(event.relatedTarget instanceof Node) || !element?.contains(event.relatedTarget)) {
        // Focus moving to nothing (for example a click on the page) is handled by the pointer.
        if (event.relatedTarget !== null) setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    element?.addEventListener("focusout", closeOnFocusLeaving);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
      element?.removeEventListener("focusout", closeOnFocusLeaving);
    };
  }, [open]);

  const currentName =
    homeId === null ? t("personalContext") : (current?.name ?? t("unknownHomeContext"));

  return (
    <div ref={container} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          // Opening asks the server for the current list too, so a Home joined or lost in
          // another tab shows up without a full reload.
          if (!open) router.refresh();
          setOpen((value) => !value);
        }}
        className="flex min-h-10 max-w-[60vw] items-center gap-2 rounded-control border border-line bg-surface px-3 text-body font-semibold text-fg hover:bg-accent-subtle sm:max-w-xs"
      >
        <span className="sr-only">{`${t("currentContext")}:`}</span>{" "}
        <bdi className="truncate">{currentName}</bdi>
        <ChevronDownIcon
          size="sm"
          className={cx(
            "shrink-0 text-fg-muted transition-transform duration-(--md-duration-fast) motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute start-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-card border border-line bg-surface-elevated p-2 shadow-overlay"
      >
        <nav aria-label={t("switchContext")}>
          <ul className="flex flex-col gap-1">
            <li>
              <Link
                href="/?context=personal"
                aria-current={homeId === null && pathname === "/" ? "page" : undefined}
                className={cx(itemClass, homeId === null && "font-semibold")}
              >
                <span>{t("personalContext")}</span>{" "}
                {homeId === null ? (
                  <span className="text-helper font-normal text-fg-muted">
                    {t("currentMarker")}
                  </span>
                ) : null}
              </Link>
            </li>
            {homes?.map((home) => (
              <li key={home.id}>
                <Link
                  href={`/homes/${home.id}`}
                  aria-current={pathname === `/homes/${home.id}` ? "page" : undefined}
                  className={cx(itemClass, home.id === homeId && "font-semibold")}
                >
                  <bdi className="min-w-0 truncate">{home.name}</bdi>{" "}
                  <span className="shrink-0 text-helper font-normal text-fg-muted">
                    {home.id === homeId
                      ? t("roleAndCurrent", { role: roleLabel(home.role) })
                      : roleLabel(home.role)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {homes === null ? (
            <p className="px-3 py-2 text-helper text-fg-muted">{t("homesUnavailable")}</p>
          ) : null}
          <div className="mt-1 border-t border-line pt-1">
            <Link href="/homes/new" className={itemClass}>
              {t("createHome")}
            </Link>
            <Link href="/homes/join" className={itemClass}>
              {t("joinHome")}
            </Link>
          </div>
        </nav>
      </div>
    </div>
  );
}
