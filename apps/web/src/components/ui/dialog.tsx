"use client";

import { CloseIcon } from "@madeora/icons";
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";

import { Button } from "./button";
import { cx } from "./cx";

export interface DialogProps {
  readonly open: boolean;
  /** Called when the person asks to close: the close button or Escape. */
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  /** Accessible name of the close button (translated by the caller). */
  readonly closeLabel: string;
  /** A function receives `requestClose`, which honours the unsaved-changes question. */
  readonly children?: ReactNode | ((requestClose: () => void) => ReactNode);
  /** Actions at the bottom, such as Cancel and Confirm buttons. */
  readonly footer?: ReactNode;
  readonly className?: string;
  /**
   * Where and how large the surface is (redesign: adaptive creation). `compact` is a small modal
   * for a few essential fields, `default` the standard modal, `large` a roomy dialog for complex
   * creation. `side` is a drawer on the inline end (a bottom sheet on small screens) and
   * `sheet` is always a bottom sheet.
   */
  readonly size?: DialogSize;
  /**
   * Unsaved changes. While true, a request to close (close button or Escape) asks first, inside
   * the same dialog, instead of discarding the person's input.
   */
  readonly dirty?: boolean;
  /** Wording of the unsaved-changes question (translated by the caller). Required with `dirty`. */
  readonly discardPrompt?: DiscardPrompt;
}

export type DialogSize = "compact" | "default" | "large" | "side" | "sheet";

export interface DiscardPrompt {
  readonly title: string;
  readonly message: string;
  /** Closes and drops the changes. */
  readonly discard: string;
  /** Goes back to editing. */
  readonly keep: string;
}

const surface: Record<DialogSize, string> = {
  compact: "m-auto w-[calc(100%-2rem)] max-w-md rounded-overlay open:animate-enter",
  default: "m-auto w-[calc(100%-2rem)] max-w-lg rounded-overlay open:animate-enter",
  large: "m-auto w-[calc(100%-2rem)] max-w-3xl rounded-overlay open:animate-enter",
  // Below `sm` a side panel is a bottom sheet, so the content keeps its width on phones.
  side: "mx-0 mb-0 mt-auto h-auto max-h-[90dvh] w-full max-w-none rounded-t-overlay open:animate-slide-up sm:mb-0 sm:ms-auto sm:mt-0 sm:h-dvh sm:max-h-dvh sm:w-[28rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-none sm:rounded-s-overlay sm:open:animate-slide-end",
  sheet:
    "mx-auto mb-0 mt-auto max-h-[90dvh] w-full max-w-2xl rounded-t-overlay open:animate-slide-up",
};

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
  size = "default",
  dirty = false,
  discardPrompt,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);

  // A fresh opening never starts on the unsaved-changes question.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setConfirming(false);
  }

  // Focus moves to the safe choice when the question appears.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  function requestClose() {
    if (dirty && discardPrompt) setConfirming(true);
    else onClose();
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      // Remember the opener once per opening. Checked separately from showModal() because
      // development StrictMode re-runs this effect while the dialog is already open.
      const active = document.activeElement;
      if (!opener.current && active instanceof HTMLElement && !dialog.contains(active)) {
        opener.current = active;
      }
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Closing returns focus to the opener.
  useEffect(() => {
    if (open) return;
    restoreFocus(opener);
  }, [open]);

  // So does unmounting while open. Development StrictMode simulates an unmount while the element
  // stays on the page; focus is left in the dialog then.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.isConnected) return;
      restoreFocus(opener);
    };
  }, []);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    // Escape: let the owner decide, so `open` stays the single source of truth.
    event.preventDefault();
    requestClose();
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
        "border border-line bg-surface-elevated p-0 text-fg shadow-overlay",
        "backdrop:bg-overlay",
        surface[size],
        className,
      )}
    >
      <div className="flex max-h-[inherit] flex-col gap-4 overflow-y-auto p-panel-padding">
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
            onClick={requestClose}
            aria-label={closeLabel}
            className="-me-2 -mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
          >
            <CloseIcon />
          </button>
        </div>
        {typeof children === "function" ? children(requestClose) : children}
        {confirming && discardPrompt ? (
          <div
            role="alertdialog"
            aria-labelledby={`${titleId}-discard`}
            aria-describedby={`${descriptionId}-discard`}
            className="flex flex-col gap-3 rounded-card border border-warning bg-warning-subtle p-4"
          >
            <p id={`${titleId}-discard`} className="text-body font-semibold">
              {discardPrompt.title}
            </p>
            <p id={`${descriptionId}-discard`} className="text-body">
              {discardPrompt.message}
            </p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                variant="secondary"
                size="sm"
                ref={keepRef}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {discardPrompt.keep}
              </Button>
              <Button variant="destructive" size="sm" onClick={onClose}>
                {discardPrompt.discard}
              </Button>
            </div>
          </div>
        ) : footer ? (
          <div className="flex flex-wrap justify-end gap-3">{footer}</div>
        ) : null}
      </div>
    </dialog>
  );
}

function restoreFocus(opener: { current: HTMLElement | null }) {
  const target = opener.current;
  opener.current = null;
  if (target?.isConnected) target.focus();
}
