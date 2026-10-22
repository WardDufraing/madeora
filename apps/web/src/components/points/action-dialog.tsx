"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { sendChoreRequest } from "@/chores/api";
import type { MemberNames } from "@/tasks/format";

export interface ActionDialogProps<Result> {
  /** Serializes changes to one record. */
  readonly scope: string;
  readonly method: "POST" | "PATCH" | "PUT";
  readonly url: string;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly variant?: ButtonVariant;
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  /**
   * Shown (and announced) in the shell's toast region after the change was saved, so it stays when
   * the saved change removes this control from the page; may depend on the answer.
   */
  readonly announcement: (result: Result) => string;
  readonly fields?: ReactNode;
  /** The body from the fields, or null (invalid: the fields show why). */
  readonly build: () => Record<string, unknown> | null;
  /** True: the database answers a preview first (`dryRun`), which the person confirms. */
  readonly previewed?: boolean;
  readonly renderPreview?: (result: Result) => ReactNode;
  readonly onOpen?: () => void;
  readonly names: MemberNames;
  readonly testId: string;
}

/**
 * A consequential points or rewards change in a dialog (S23): the person fills in what it needs,
 * sees the preview the database answers (`dryRun`) and confirms exactly that body. Editing a field
 * drops the preview, so nothing unseen is confirmed.
 */
export function ActionDialog<Result>({
  scope,
  method,
  url,
  label,
  ariaLabel,
  variant = "secondary",
  title,
  description,
  confirmLabel,
  announcement,
  fields,
  build,
  previewed = true,
  renderPreview,
  onOpen,
  names,
  testId,
}: ActionDialogProps<Result>) {
  const t = useTranslations("Points");
  const texts = useChoreTexts(names);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ body: Record<string, unknown>; result: Result } | null>(
    null,
  );
  const toast = useToast();
  const mutation = useChoreMutation(
    scope,
    ({ body, dryRun }: { body: Record<string, unknown>; dryRun: boolean }) =>
      sendChoreRequest<Result>(method, url, previewed ? { ...body, dryRun } : body),
    (result, { body, dryRun }) => {
      if (dryRun) {
        setPreview({ body, result });
        return;
      }
      setOpen(false);
      setPreview(null);
      toast.show({ title: announcement(result), tone: "success" });
    },
    { refresh: (_result, { dryRun }) => !dryRun },
  );
  const close = () => {
    setOpen(false);
    setPreview(null);
    mutation.reset();
  };

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        onClick={() => {
          mutation.reset();
          setPreview(null);
          onOpen?.();
          setOpen(true);
        }}
        aria-label={ariaLabel}
        data-testid={`${testId}-open`}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={title}
        {...(description ? { description } : {})}
        closeLabel={t("close")}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t("cancel")}
            </Button>
            {preview ? (
              <Button
                loading={mutation.busy}
                onClick={() => {
                  mutation.mutate({ body: preview.body, dryRun: false });
                }}
                data-testid={`${testId}-confirm`}
              >
                {confirmLabel}
              </Button>
            ) : (
              <Button
                loading={mutation.busy}
                onClick={() => {
                  const body = build();
                  if (body) mutation.mutate({ body, dryRun: previewed });
                }}
                data-testid={`${testId}-next`}
              >
                {previewed ? t("preview") : confirmLabel}
              </Button>
            )}
          </>
        }
      >
        {fields ? (
          <div
            className="flex flex-col gap-3"
            onChange={() => {
              setPreview(null);
            }}
          >
            {fields}
          </div>
        ) : null}
        {preview && renderPreview ? (
          <div className="mt-3" data-testid={`${testId}-preview`}>
            {renderPreview(preview.result)}
          </div>
        ) : null}
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure, mutation.error.detail)}
          </FormAlert>
        ) : null}
      </Dialog>
    </>
  );
}
