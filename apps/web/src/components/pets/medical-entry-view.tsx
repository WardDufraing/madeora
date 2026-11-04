"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  medicalAttachmentEndpoint,
  medicalEntryEndpoint,
  sendPetRequest,
  type MedicalAttachment,
  type MedicalEntryDetail,
} from "@/pets/api";
import { petPath } from "@/pets/format";
import { PET_LIMITS, petAttachmentTypes } from "@/pets/schema";
import {
  newPetAttempt,
  PetUploadError,
  uploadMedicalAttachment,
  type PetUploadAttempt,
  type PetUploadFailure,
} from "@/pets/upload";
import { fileContentPath } from "@/storage/api";

import { MedicalEntryForm } from "./medical-entry-form";
import { ConfirmDialog, NotEntered, PetFailureAlert, PetValue } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

/**
 * One medical entry (S31), for someone with medical view: its details and supporting documents,
 * each opened through Madeora's authorizing file route (a 60-second link, checked at that moment).
 * Medical managers correct it, add documents (images and PDF, 10 MB each, 10 per entry), remove them
 * and move the entry to the trash.
 */
export function MedicalEntryView({
  entry,
  birthDate,
}: {
  readonly entry: MedicalEntryDetail;
  readonly birthDate: string | null;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const manage = entry.level === "manage";
  const remove = usePetMutation(
    `pet-entry:${entry.id}`,
    () => sendPetRequest("DELETE", medicalEntryEndpoint(entry.id), { revision: entry.revision }),
    () => {
      router.push(petPath(entry.homeId, entry.petId));
    },
  );
  const upcoming = entry.date > entry.today;
  const value = (text: string | null) => text ?? <NotEntered />;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-2">
          <p className="text-helper text-fg-muted">
            {upcoming ? t("upcomingLabel") : texts.eventType(entry.type)}
          </p>
          <h1 className="text-page-title font-semibold text-fg" data-testid="pet-entry-heading">
            <bdi>{entry.title ?? texts.eventType(entry.type)}</bdi>
          </h1>
          <p className="text-body text-fg-muted">
            <time dateTime={entry.date}>{texts.date(entry.date)}</time>
          </p>
          {manage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setEditing(true);
                }}
                data-testid="pet-entry-edit"
              >
                {t("editEntry")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  remove.reset();
                  setDeleting(true);
                }}
                data-testid="pet-entry-delete"
              >
                {t("deleteEntry")}
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card title={t("sectionEntryDetails")}>
        <dl className="flex flex-col gap-3">
          <PetValue label={t("fieldEventType")}>{texts.eventType(entry.type)}</PetValue>
          <PetValue label={t("fieldVeterinarian")}>{value(entry.veterinarian)}</PetValue>
          <PetValue label={t("fieldLocation")}>{value(entry.location)}</PetValue>
          <PetValue label={t("fieldTreatment")}>{value(entry.treatment)}</PetValue>
          <PetValue label={t("fieldEntryNotes")}>{value(entry.notes)}</PetValue>
          <PetValue label={t("fieldFollowUp")}>
            {entry.followUpDate ? texts.date(entry.followUpDate) : <NotEntered />}
          </PetValue>
        </dl>
      </Card>

      <Card title={t("sectionAttachments")} description={t("attachmentsHint")}>
        <Attachments entry={entry} manage={manage} />
      </Card>

      {editing ? (
        <MedicalEntryForm
          homeId={entry.homeId}
          petId={entry.petId}
          birthDate={birthDate}
          today={entry.today}
          entry={entry}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={t("deleteEntryTitle")}
          description={t("deleteEntryExplanation")}
          confirmLabel={t("deleteEntryConfirm")}
          busy={remove.busy}
          error={remove.error}
          onConfirm={() => {
            remove.mutate(undefined);
          }}
          onClose={() => {
            setDeleting(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Attachments({
  entry,
  manage,
}: {
  readonly entry: MedicalEntryDetail;
  readonly manage: boolean;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ file: File; attempt: PetUploadAttempt } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<PetUploadFailure | null>(null);
  /** The file of a failed upload that a retry sends again (same attempt, same upload). */
  const [retryable, setRetryable] = useState<File | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const full = entry.attachments.length >= PET_LIMITS.attachments;

  const upload = async (file: File) => {
    if (attempt.current?.file !== file) attempt.current = { file, attempt: newPetAttempt() };
    setUploading(true);
    setFailure(null);
    setAdded(null);
    try {
      await uploadMedicalAttachment(entry.id, file, attempt.current.attempt);
      attempt.current = null;
      setRetryable(null);
      setAdded(file.name);
      router.refresh();
    } catch (error) {
      const reason = error instanceof PetUploadError ? error.failure : "failed";
      setFailure(reason);
      setRetryable(reason === "type" || reason === "size" || reason === "limit" ? null : file);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {entry.attachments.length === 0 ? (
        <p className="text-body text-fg-muted">{t("noAttachments")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" data-testid="pet-attachments">
          {entry.attachments.map((attachment) => (
            <AttachmentRow key={attachment.id} attachment={attachment} manage={manage} />
          ))}
        </ul>
      )}
      {failure ? (
        <FormAlert tone="error" announce>
          {texts.upload(failure)}
          {retryable ? (
            <>
              {" "}
              <button
                type="button"
                className="font-medium text-accent-fg underline"
                onClick={() => {
                  void upload(retryable);
                }}
              >
                {t("retry")}
              </button>
            </>
          ) : null}
        </FormAlert>
      ) : null}
      {added ? (
        <FormAlert tone="success" announce>
          {t("attachmentAdded", { name: added })}
        </FormAlert>
      ) : null}
      {manage ? (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            accept={[...petAttachmentTypes, ".pdf", ".jpg", ".jpeg", ".png", ".webp"].join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
            data-testid="pet-attachment-input"
          />
          <Button
            variant="secondary"
            loading={uploading}
            disabled={full}
            onClick={() => {
              input.current?.click();
            }}
            data-testid="pet-attachment-add"
          >
            {uploading ? t("uploading") : t("addAttachment")}
          </Button>
          {full ? (
            <p className="text-helper text-fg-muted">
              {t("attachmentsFull", { max: PET_LIMITS.attachments })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentRow({
  attachment,
  manage,
}: {
  readonly attachment: MedicalAttachment;
  readonly manage: boolean;
}) {
  const t = useTranslations("Pets");
  const remove = usePetMutation(`pet-attachment:${attachment.id}`, () =>
    sendPetRequest("DELETE", medicalAttachmentEndpoint(attachment.id), {}),
  );
  const size =
    attachment.size === null
      ? null
      : attachment.size >= 1024 * 1024
        ? t("sizeMb", { size: Math.round((attachment.size / (1024 * 1024)) * 10) / 10 })
        : t("sizeKb", { size: Math.max(1, Math.round(attachment.size / 1024)) });
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-col">
        <a
          href={fileContentPath(attachment.fileId)}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-body font-medium text-accent-fg underline"
          data-testid="pet-attachment-link"
        >
          <bdi>{attachment.name}</bdi>
        </a>
        {size ? <span className="text-helper text-fg-muted">{size}</span> : null}
      </span>
      {manage ? (
        <span className="flex flex-col items-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            loading={remove.busy}
            aria-label={t("removeAttachmentNamed", { name: attachment.name })}
            onClick={() => {
              remove.mutate(undefined);
            }}
            data-testid="pet-attachment-remove"
          >
            {t("removeAttachment")}
          </Button>
          <PetFailureAlert error={remove.error} />
        </span>
      ) : null}
    </li>
  );
}
