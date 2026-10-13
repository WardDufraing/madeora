"use client";

import { CloseIcon } from "@madeora/icons";
import { useEffect, useId, useRef, type ReactNode, type SyntheticEvent } from "react";

import { cx } from "./cx";

export interface DialogProps {
  readonly open: boolean;
  /** Called when the person asks to close: the close button or Escape. */
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  /** Accessible name of the close button (translated by the caller). */
  readonly closeLabel: string;
  readonly children?: ReactNode;
  /** Actions at the bottom, such as Cancel and Confirm buttons. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * A modal dialog on the native `<dialog>` element: the browser makes the rest of the page inert,
 * traps focus, moves focus into the dialog and handles Escape. Focus returns to the element that
 * opened it when it closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  closeLabel,
  children,
  footer,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Closing returns focus to the opener.
  useEffect(() => {
    if (open) return;
    restoreFocus(opener);
  }, [open]);

  // So does unmounting while open.
  useEffect(
    () => () => {
      restoreFocus(opener);
    },
    [],
  );

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    // Escape: let the owner decide, so `open` stays the single source of truth.
    event.preventDefault();
    onClose();
  }

  function handleNativeClose() {
    // The browser closed it on its own (for example a form with method="dialog").
    if (open) onClose();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={handleCancel}
      onClose={handleNativeClose}
      className={cx(
        "m-auto w-[calc(100%-2rem)] max-w-lg rounded-card border border-line bg-surface-elevated p-0 text-fg shadow-overlay",
        "backdrop:bg-overlay open:animate-enter",
        className,
      )}
    >
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-section-title font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-body text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="-me-2 -mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
        {footer ? <div className="flex flex-wrap justify-end gap-3">{footer}</div> : null}
      </div>
    </dialog>
  );
}

function restoreFocus(opener: { current: HTMLElement | null }) {
  const target = opener.current;
  opener.current = null;
  if (target?.isConnected) target.focus();
}
