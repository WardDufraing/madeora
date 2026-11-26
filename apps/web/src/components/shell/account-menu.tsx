"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";

export interface AccountMenuProps {
  /** The person's display name, when they have set one; the menu shows an initial either way. */
  readonly displayName: string | null;
}

const itemClass =
  "flex min-h-10 w-full items-center rounded-control px-3 text-start text-body font-semibold text-fg hover:bg-accent-subtle";

/**
 * The top bar's account control: one round avatar that opens Switch account and Sign out, so the
 * header stays calm. A disclosure with plain links and a form button, like the context switcher,
 * so it works the same with keyboard, screen reader and touch. Escape closes it and returns focus.
 */
export function AccountMenu({ displayName }: AccountMenuProps) {
  const t = useTranslations("Shell");
  const tAccounts = useTranslations("Accounts");
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const initial = Array.from(displayName?.trim() ?? "")[0]?.toLocaleUpperCase() ?? null;

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
      if (event.relatedTarget instanceof Node && !element?.contains(event.relatedTarget)) {
        setOpen(false);
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

  return (
    <div ref={container} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t("accountMenu")}
        data-testid="account-menu"
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="inline-flex size-10 items-center justify-center rounded-full bg-accent-subtle text-body font-bold text-accent-fg hover:bg-accent hover:text-on-accent"
      >
        <span aria-hidden="true">{initial ?? "\u{25CF}"}</span>
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute end-0 top-full z-40 mt-3 w-64 max-w-[calc(100vw-2rem)] rounded-card border border-line bg-surface-elevated p-2 shadow-overlay"
      >
        {displayName ? (
          <p className="truncate px-3 py-2 text-helper text-fg-muted">
            <bdi>{t("signedInAs", { name: displayName })}</bdi>
          </p>
        ) : null}
        <Link
          href="/accounts"
          className={itemClass}
          data-testid="switch-account-link"
          onClick={() => {
            setOpen(false);
          }}
        >
          {tAccounts("switchAccount")}
        </Link>
        <SignOutButton variant="menu" />
      </div>
    </div>
  );
}
