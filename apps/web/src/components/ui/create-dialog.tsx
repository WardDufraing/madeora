"use client";

import type { ReactNode, SubmitEvent } from "react";

import { Button } from "./button";
import { Dialog, type DialogSize, type DiscardPrompt } from "./dialog";

export interface CreateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly closeLabel: string;
  /** `compact` for a few essential fields, `large` for complex creation, `side` for a drawer. */
  readonly size?: Exclude<DialogSize, "sheet">;
  readonly submitLabel: string;
  readonly cancelLabel: string;
  /** Called on a valid submit (Enter in a field or the submit button). */
  readonly onSubmit: () => void | Promise<void>;
  /** Shows the busy state and ignores a second submit while saving. */
  readonly submitting?: boolean;
  readonly dirty?: boolean;
  readonly discardPrompt?: DiscardPrompt;
  /** A form-level error, shown above the actions and announced. */
  readonly error?: string;
  readonly children: ReactNode;
}

/**
 * The shared shell for creating things in a dialog (redesign: adaptive creation). Every module
 * gets the same placement of Cancel and Save, the same busy state, the same unsaved-changes
 * question and the same focus return to the button that opened it. Fields and validation
 * stay with the module; the page route behind it is untouched, so scroll position, filters and
 * the active Personal or Home context survive opening and closing.
 */
export function CreateDialog({
  open,
  onClose,
  title,
  description,
  closeLabel,
  size = "compact",
  submitLabel,
  cancelLabel,
  onSubmit,
  submitting = false,
  dirty,
  discardPrompt,
  error,
  children,
}: CreateDialogProps) {
  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    void onSubmit();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      {...(description !== undefined && { description })}
      closeLabel={closeLabel}
      size={size}
      {...(dirty !== undefined && { dirty })}
      {...(discardPrompt !== undefined && { discardPrompt })}
    >
      {(requestClose) => (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          {children}
          {error ? (
            <p role="alert" className="text-body text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="ghost" onClick={requestClose} disabled={submitting}>
              {cancelLabel}
            </Button>
            <Button type="submit" loading={submitting}>
              {submitLabel}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
