"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import type { PetRequestError } from "@/pets/api";
import { fileContentPath } from "@/storage/api";

import { usePetTexts } from "./use-pet-texts";

/** A refused or failed request, announced at once. */
export function PetFailureAlert({ error }: { readonly error: PetRequestError | null }) {
  const texts = usePetTexts();
  return error ? (
    <FormAlert tone="error" announce>
      {texts.failure(error.failure)}
    </FormAlert>
  ) : null;
}

/**
 * A pet's photo, or a neutral initial without one. Decorative: the name is always beside it. The
 * file is read through the authorizing content route.
 */
export function PetPhoto({
  fileId,
  name,
  size,
}: {
  readonly fileId: string | null;
  readonly name: string;
  readonly size: "card" | "profile";
}) {
  const frame = cx(
    "shrink-0 overflow-hidden rounded-card bg-surface-sunken",
    size === "card" ? "size-16" : "size-32",
  );
  if (!fileId) {
    return (
      <div
        aria-hidden="true"
        className={cx(
          frame,
          "flex items-center justify-center font-semibold text-fg-muted",
          size === "card" ? "text-section-title" : "text-page-title",
        )}
      >
        {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? ""}
      </div>
    );
  }
  return (
    <div className={frame}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, per-viewer authorized redirect; next/image would cache it for everyone */}
      <img
        src={fileContentPath(fileId)}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
    </div>
  );
}

/** One labelled value in a definition list; empty shows "Not entered", never "None". */
export function PetValue({
  label,
  children,
  testId,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-body font-medium text-fg-muted sm:w-48 sm:shrink-0">{label}</dt>
      <dd
        className="min-w-0 whitespace-pre-line break-words text-body text-fg"
        data-testid={testId}
      >
        {children}
      </dd>
    </div>
  );
}

export function NotEntered() {
  const t = useTranslations("Pets");
  return <span className="text-fg-muted">{t("notEntered")}</span>;
}

/** Asks before a destructive step; the step itself runs in `onConfirm`. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly error: PetRequestError | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      closeLabel={t("close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            onClick={onConfirm}
            data-testid="pet-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <PetFailureAlert error={error} />
    </Dialog>
  );
}
