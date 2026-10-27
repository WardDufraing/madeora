"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { coverTypes } from "@/recipes/schema";
import { CoverUploadError, uploadCover, type CoverFailure } from "@/recipes/cover-upload";

import { RecipeCover } from "./recipe-cover";

const failureKey = {
  type: "coverFailureType",
  size: "coverFailureSize",
  storageFull: "coverFailureStorageFull",
  storageOff: "coverFailureStorageOff",
  rateLimited: "coverFailureRateLimited",
  invalidFile: "coverFailureInvalid",
  expired: "coverFailureExpired",
  notPermitted: "coverFailureNotPermitted",
  signedOut: "failureSignedOut",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<CoverFailure, string>;

export interface CoverFieldProps {
  /** The saved cover's file id, a new upload's, or null for none. */
  readonly value: string | null;
  /** The recipe's saved cover (shown until a new one is chosen). */
  readonly saved: string | null;
  readonly onChange: (fileId: string | null) => void;
  readonly target: { readonly recipeId: string | null; readonly lockToken: string | null };
  readonly disabled?: boolean;
}

/**
 * The recipe's one optional cover photo (S24): choose a JPEG, PNG or WebP up to 10 MB, see it
 * before saving, replace or remove it. Nothing changes on the recipe until Save.
 */
export function CoverField({ value, saved, onChange, target, disabled = false }: CoverFieldProps) {
  const t = useTranslations("Recipes");
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ readonly fileId: string; readonly url: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CoverFailure | null>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  async function choose(file: File) {
    setFailure(null);
    setBusy(true);
    try {
      const fileId = await uploadCover(file, target, crypto.randomUUID());
      setPreview({ fileId, url: URL.createObjectURL(file) });
      onChange(fileId);
    } catch (error) {
      setFailure(error instanceof CoverUploadError ? error.failure : "failed");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const showingNew = preview !== null && value === preview.fileId;
  return (
    <fieldset className="flex flex-col gap-2" data-testid="cover-field">
      <legend className="text-body font-medium text-fg">{t("coverLabel")}</legend>
      <p className="text-helper text-fg-muted">{t("coverHelp")}</p>
      <div className="w-full max-w-xs">
        {showingNew ? (
          <div className="aspect-[4/3] w-full overflow-hidden rounded-card bg-surface-sunken">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file */}
            <img src={preview.url} alt="" className="size-full object-cover" />
          </div>
        ) : (
          <RecipeCover fileId={value === saved ? value : null} size="card" />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          accept={coverTypes.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void choose(file);
          }}
          data-testid="cover-input"
        />
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          {value ? t("replaceCover") : t("chooseCover")}
        </Button>
        {value ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onClick={() => {
              onChange(null);
            }}
          >
            {t("removeCover")}
          </Button>
        ) : null}
      </div>
      {value !== saved ? (
        <p className="text-helper text-fg-muted" role="status">
          {value ? t("coverPendingSave") : t("coverRemovedPendingSave")}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-helper text-danger">
          {t(failureKey[failure])}
        </p>
      ) : null}
    </fieldset>
  );
}
