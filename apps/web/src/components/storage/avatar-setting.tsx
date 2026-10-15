"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import type { AccentColor } from "@/accent/accent";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberAvatar } from "@/components/members/member-avatar";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  AvatarUploadError,
  clearAvatar,
  uploadAvatar,
  type AvatarFailure,
  type AvatarScope,
} from "@/storage/api";
import { avatarUploadTypes } from "@/storage/schema";

export interface AvatarSettingProps {
  readonly scope: AvatarScope;
  /** The avatar chosen for this scope, or null (global: none; Home: inherits the global one). */
  readonly currentFileId: string | null;
  /** In a Home: the global avatar shown while the Home inherits it. */
  readonly inheritedFileId?: string | null;
  /** For the preview: the effective name and colour in this scope. */
  readonly name: string | null;
  readonly accentColor: AccentColor | null;
  readonly locale: string;
  /** False where storage is not set up: the picture can be removed but not changed. */
  readonly uploadsEnabled: boolean;
}

const failureKey = {
  type: "avatarErrorType",
  size: "avatarErrorSize",
  storageFull: "avatarErrorFull",
  rateLimited: "avatarErrorRateLimited",
  invalidImage: "avatarErrorInvalid",
  expired: "avatarErrorExpired",
  unavailable: "avatarErrorUnavailable",
  signedOut: "avatarErrorSignedOut",
  notFound: "avatarErrorNotFound",
  network: "avatarErrorNetwork",
  failed: "avatarErrorFailed",
} as const satisfies Record<AvatarFailure, string>;

/**
 * Choosing a picture (S15): the global avatar in Settings, or the person's own override in one
 * Home. The file goes straight to storage through a short-lived signed link; the server checks and
 * re-encodes it before it is used (photo metadata is removed). Errors say what to do; a full
 * storage names the person's own storage and links to it. Keyboard and screen reader friendly:
 * a real file input with a visible label, status messages announced.
 */
export function AvatarSetting({
  scope,
  currentFileId,
  inheritedFileId = null,
  name,
  accentColor,
  locale,
  uploadsEnabled,
}: AvatarSettingProps) {
  const t = useTranslations("Storage");
  const router = useRouter();
  const hydrated = useHydrated();
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "clear" | null>(null);
  const [failure, setFailure] = useState<AvatarFailure | null>(null);
  const [done, setDone] = useState<"saved" | "removed" | null>(null);
  const shown = currentFileId ?? (scope.kind === "home" ? inheritedFileId : null);

  async function run(kind: "upload" | "clear", action: () => Promise<unknown>) {
    setBusy(kind);
    setFailure(null);
    setDone(null);
    try {
      await action();
      setDone(kind === "upload" ? "saved" : "removed");
      router.refresh();
    } catch (error) {
      setFailure(error instanceof AvatarUploadError ? error.failure : "failed");
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid={`avatar-setting-${scope.kind}`}>
      <div className="flex items-center gap-4">
        <MemberAvatar
          name={name}
          accentColor={accentColor}
          locale={locale}
          avatarFileId={shown}
          size="lg"
        />
        <p className="text-body text-fg-muted" data-testid="avatar-state">
          {currentFileId
            ? t(scope.kind === "home" ? "avatarHomeOwn" : "avatarGlobalSet")
            : scope.kind === "home"
              ? t("avatarHomeInherits")
              : t("avatarGlobalNone")}
        </p>
      </div>
      {uploadsEnabled ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-body font-medium text-fg">
            {t("avatarChoose")}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={avatarUploadTypes.join(",")}
            aria-describedby={hintId}
            disabled={!hydrated || busy !== null}
            className="text-body text-fg file:me-3 file:rounded-md file:border file:border-line-control file:bg-surface file:px-3 file:py-2 file:text-body file:font-medium file:text-fg"
            data-testid="avatar-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void run("upload", () => uploadAvatar(file, scope));
            }}
          />
          <p id={hintId} className="text-helper text-fg-muted">
            {t("avatarHint")}
          </p>
        </div>
      ) : (
        <p className="text-helper text-fg-muted" data-testid="avatar-uploads-off">
          {t("avatarUploadsOff")}
        </p>
      )}
      {busy === "upload" ? (
        <FormAlert tone="info" announce>
          {t("avatarUploading")}
        </FormAlert>
      ) : null}
      {failure ? (
        <FormAlert tone="error" announce>
          <p data-testid="avatar-error">{t(failureKey[failure])}</p>
          {failure === "storageFull" ? (
            <Link href="/settings/storage" className="font-medium underline">
              {t("openStorage")}
            </Link>
          ) : null}
        </FormAlert>
      ) : null}
      {done && busy === null ? (
        <FormAlert tone="success" announce>
          <p data-testid="avatar-done">
            {done === "saved"
              ? t("avatarSaved")
              : t(scope.kind === "home" ? "avatarHomeReset" : "avatarRemoved")}
          </p>
        </FormAlert>
      ) : null}
      {currentFileId ? (
        <div>
          <Button
            variant="secondary"
            disabled={!hydrated || busy !== null}
            loading={busy === "clear"}
            onClick={() => void run("clear", () => clearAvatar(scope))}
            data-testid="avatar-clear"
          >
            {scope.kind === "home" ? t("avatarUseGlobal") : t("avatarRemove")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
