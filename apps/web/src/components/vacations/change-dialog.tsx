"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendChoreRequest } from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import type { MemberNames } from "@/tasks/format";
import type { VacationMutationResult } from "@/vacations/api";

import { ImpactPreview } from "./impact-preview";

export interface ChangeDialogProps {
  /** Serializes changes to one record. */
  readonly scope: string;
  readonly method: "PATCH" | "POST";
  readonly url: string;
  /** The opener's text and accessible name. */
  readonly label: string;
  readonly ariaLabel?: string;
  readonly variant?: ButtonVariant;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly announcement: string;
  /** Inputs of the change, if any; `build` reads them and answers the body, or null (invalid). */
  readonly fields?: ReactNode;
  readonly build: () => Record<string, unknown> | null;
  /** Some changes have no effect on chores worth showing (a name): saved without a preview. */
  readonly previewed?: boolean;
  /** False for endpoints without previews (absences): the body is sent as built. */
  readonly withDryRun?: boolean;
  readonly onOpen?: () => void;
  readonly names: MemberNames;
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
  readonly testId: string;
}

/**
 * A consequential vacation change in a dialog (S22): the person fills in what it needs, sees the
 * preview the database answers (`dryRun`: what changes for chores) and confirms exactly that body,
 * with the revision they saw. Editing a field drops the preview, so nothing unseen is confirmed.
 */
export function ChangeDialog({
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
  withDryRun = true,
  onOpen,
  names,
  formats,
  testId,
}: ChangeDialogProps) {
  const t = useTranslations("Vacations");
  const texts = useChoreTexts(names);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{
    body: Record<string, unknown>;
    result: VacationMutationResult;
  } | null>(null);
  const { announce, region } = useAnnouncer();
  const mutation = useChoreMutation(
    scope,
    ({ body, dryRun }: { body: Record<string, unknown>; dryRun: boolean }) =>
      sendChoreRequest<VacationMutationResult>(
        method,
        url,
        withDryRun ? { ...body, dryRun } : body,
      ),
    (result, { body, dryRun }) => {
      if (dryRun) {
        setPreview({ body, result });
        return;
      }
      setOpen(false);
      setPreview(null);
      announce(announcement);
    },
    { refresh: (_result, { dryRun }) => !dryRun },
  );
  const close = () => {
    setOpen(false);
    setPreview(null);
    mutation.reset();
  };
  const next = () => {
    const body = build();
    if (!body) return;
    mutation.mutate({ body, dryRun: previewed });
  };

  return (
    <>
      {region}
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
        description={description}
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
              <Button loading={mutation.busy} onClick={next} data-testid={`${testId}-next`}>
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
        {preview?.result.impact ? (
          <ImpactPreview
            impact={preview.result.impact}
            names={names}
            formats={formats}
            testId={`${testId}-impact`}
          />
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
