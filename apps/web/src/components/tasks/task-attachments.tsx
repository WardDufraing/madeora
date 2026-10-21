"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { isolate } from "@/invitations/format";
import { fileContentPath } from "@/storage/api";
import { formatBytes } from "@/storage/usage-view";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  TaskRequestError,
  type AttachmentRemoveResponse,
  type AttachmentScopeImpact,
  type TaskAttachment,
  type TaskAttachmentView,
} from "@/tasks/api";
import {
  attachmentAccept,
  attachmentTypes,
  isAttachmentType,
  type AttachmentScope,
} from "@/tasks/attachment-policy";
import {
  AttachmentUploadError,
  checkAttachmentFile,
  newAttempt,
  uploadAttachment,
  type AttachmentFailure,
  type UploadAttempt,
} from "@/tasks/attachment-upload";
import { memberNames, taskKeys, type MemberOption } from "@/tasks/format";

import { useTaskTexts } from "./use-task-texts";

export const TASK_ATTACHMENTS_ENDPOINT = "/api/v1/task-attachments";

export interface TaskAttachmentsProps {
  readonly taskId: string;
  readonly view: TaskAttachmentView;
  /** An occurrence of a recurring series: adding and removing may ask the scope. */
  readonly recurring: boolean;
  /** "This and following" is offered (the occurrence is open and in the current series part). */
  readonly followingAllowed: boolean;
  /** File storage is configured here; without it nothing can be uploaded. */
  readonly storageAvailable: boolean;
  readonly members: readonly MemberOption[];
}

type Upload =
  | { readonly state: "idle" }
  | {
      readonly state: "uploading";
      readonly name: string;
      readonly progress: number;
      readonly controller: AbortController;
    }
  | {
      readonly state: "failed";
      readonly name: string;
      readonly failure: AttachmentFailure;
      readonly file: File | null;
      readonly scope: AttachmentScope;
      /** Reused by Retry, so a retry never opens a second upload for the same attempt. */
      readonly attempt: UploadAttempt | null;
    };

/**
 * A task's attachments (S19c; spec "Confirmed task document and image attachments"): images with a
 * preview, PDFs that open in the browser, other files to download, each with its name, type and
 * size and whether it came from the series. The task's editors add and remove files (the scope is
 * asked on an occurrence when they may change the series); everyone who sees the task can open
 * and download them. Every file is served through Madeora's authorized link, checked again on each
 * request. Removing puts it in the trash; the page refreshes after each change.
 */
export function TaskAttachments({
  taskId,
  view,
  recurring,
  followingAllowed,
  storageAvailable,
  members,
}: TaskAttachmentsProps) {
  const t = useTranslations("TaskAttachments");
  const tTasks = useTranslations("Tasks");
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [, startTransition] = useTransition();
  const texts = useTaskTexts(memberNames(members));
  const inputId = useId();
  const helpId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { announce, region } = useAnnouncer();
  const [upload, setUpload] = useState<Upload>({ state: "idle" });
  const [choosingScope, setChoosingScope] = useState<File | null>(null);
  const [removing, setRemoving] = useState<TaskAttachment | null>(null);

  const count = view.attachments.length;
  const full = count >= view.limit;
  const askScope = recurring && view.canChangeSeries;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: taskKeys.all });
    startTransition(() => {
      router.refresh();
    });
  };

  const failureText = (failure: AttachmentFailure) => t(failureKey[failure], { limit: view.limit });

  async function start(file: File, scope: AttachmentScope, attempt: UploadAttempt = newAttempt()) {
    const controller = new AbortController();
    setUpload({ state: "uploading", name: file.name, progress: 0, controller });
    announce(t("announceUploading", { name: isolate(file.name) }));
    try {
      const result = await uploadAttachment(taskId, file, scope, attempt, {
        signal: controller.signal,
        onProgress: (progress) => {
          setUpload((current) =>
            current.state === "uploading" && current.controller === controller
              ? { ...current, progress }
              : current,
          );
        },
      });
      setUpload({ state: "idle" });
      announce(
        result.impact
          ? t("announceAddedSeries", { name: isolate(file.name), count: result.impact.changed })
          : t("announceAdded", { name: isolate(file.name) }),
      );
      refresh();
    } catch (error) {
      const failure = error instanceof AttachmentUploadError ? error.failure : "failed";
      if (failure === "cancelled") {
        setUpload({ state: "idle" });
        announce(t("announceCancelled"));
        return;
      }
      // An expired upload cannot be resumed: its retry starts a new one.
      setUpload({
        state: "failed",
        name: file.name,
        failure,
        file,
        scope,
        attempt: failure === "expired" ? null : attempt,
      });
    }
  }

  function choose(file: File) {
    const checked = checkAttachmentFile(file);
    if ("problem" in checked) {
      setUpload({
        state: "failed",
        name: file.name,
        failure: checked.problem,
        file: null,
        scope: "this",
        attempt: null,
      });
      return;
    }
    if (askScope) setChoosingScope(file);
    else void start(file, "this");
  }

  const canUpload = view.canAdd && storageAvailable;

  return (
    <section aria-labelledby="task-attachments-heading" className="flex flex-col gap-3">
      {region}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="task-attachments-heading" className="text-section-title font-semibold text-fg">
          {t("heading")}
        </h2>
        <p className="text-helper text-fg-muted" data-testid="attachment-count">
          {t("count", { count, limit: view.limit })}
        </p>
      </div>

      {count === 0 ? <p className="text-body text-fg-muted">{t("empty")}</p> : null}
      {count > 0 ? (
        <ul className="flex flex-col gap-3" data-testid="task-attachments">
          {view.attachments.map((attachment) => (
            <AttachmentRow
              key={attachment.id}
              attachment={attachment}
              locale={locale}
              addedBy={texts.person(attachment.addedBy)}
              onRemove={() => {
                setRemoving(attachment);
              }}
            />
          ))}
        </ul>
      ) : null}

      {view.canAdd && !storageAvailable ? (
        <FormAlert tone="info">{t("storageOff")}</FormAlert>
      ) : null}

      {canUpload ? (
        <div className="flex flex-col gap-2">
          <p id={helpId} className="text-helper text-fg-muted">
            {t("allowed", { limit: view.limit })}
          </p>
          {upload.state === "uploading" ? (
            <div className="flex flex-col gap-2" data-testid="attachment-upload">
              <label className="text-body text-fg" htmlFor={`${inputId}-progress`}>
                {t("uploading", { name: isolate(upload.name) })}
              </label>
              <progress
                id={`${inputId}-progress`}
                max={1}
                value={upload.progress}
                className="h-2 w-full max-w-sm accent-accent"
              />
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    upload.controller.abort();
                  }}
                >
                  {t("cancelUpload")}
                </Button>
              </div>
            </div>
          ) : full ? (
            <p className="text-body text-fg-muted">{t("full", { limit: view.limit })}</p>
          ) : (
            <div>
              {/* A native file input, labelled as a button: keyboard and screen readers work. */}
              <input
                ref={input}
                id={inputId}
                type="file"
                accept={attachmentAccept}
                aria-describedby={helpId}
                className="peer sr-only"
                data-testid="attachment-input"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) choose(file);
                }}
              />
              <label
                htmlFor={inputId}
                className="inline-flex min-h-10 cursor-pointer items-center rounded-control border border-line-control bg-surface px-4 text-body font-medium text-fg hover:bg-accent-subtle peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus"
              >
                {t("add")}
              </label>
            </div>
          )}
          {upload.state === "failed" ? (
            <FormAlert tone="error" announce>
              <p>
                {t("failedFor", { name: isolate(upload.name) })} {failureText(upload.failure)}
              </p>
              {upload.file && retryable(upload.failure) ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    if (upload.file)
                      void start(upload.file, upload.scope, upload.attempt ?? newAttempt());
                  }}
                >
                  {t("retry")}
                </Button>
              ) : null}
            </FormAlert>
          ) : null}
        </div>
      ) : null}

      {choosingScope ? (
        <ScopeDialog
          taskId={taskId}
          title={t("addScopeTitle", { name: isolate(choosingScope.name) })}
          confirmLabel={t("add")}
          followingAllowed={followingAllowed}
          onClose={() => {
            setChoosingScope(null);
          }}
          onConfirm={(scope) => {
            const file = choosingScope;
            setChoosingScope(null);
            void start(file, scope);
          }}
        />
      ) : null}
      {removing ? (
        <RemoveDialog
          attachment={removing}
          allowSeries={removing.fromSeries && removing.seriesActive && view.canChangeSeries}
          followingAllowed={followingAllowed}
          onClose={() => {
            setRemoving(null);
          }}
          onRemoved={(name) => {
            setRemoving(null);
            announce(t("announceRemoved", { name: isolate(name) }));
            refresh();
          }}
          failureText={(error) => texts.failure(error.failure)}
          closeLabel={tTasks("close")}
        />
      ) : null}
    </section>
  );
}

const failureKey = {
  type: "failureType",
  size: "failureSize",
  limit: "failureLimit",
  storageFull: "failureStorageFull",
  storageOff: "failureStorageOff",
  rateLimited: "failureRateLimited",
  invalidFile: "failureInvalidFile",
  expired: "failureExpired",
  notPermitted: "failureNotPermitted",
  notFound: "failureNotFound",
  scopeUnavailable: "failureScopeUnavailable",
  signedOut: "failureSignedOut",
  network: "failureNetwork",
  cancelled: "failureCancelled",
  failed: "failureFailed",
} as const satisfies Record<AttachmentFailure, string>;

function retryable(failure: AttachmentFailure): boolean {
  return ["network", "expired", "rateLimited", "failed", "storageOff"].includes(failure);
}

type TypeLabelKey = "typeFile" | "typeImage" | "typePdf" | "typeCsv" | "typeText" | "typeDocument";

function typeLabelKey(contentType: string): TypeLabelKey {
  if (!isAttachmentType(contentType)) return "typeFile";
  switch (attachmentTypes[contentType].kind) {
    case "image":
      return "typeImage";
    case "pdf":
      return "typePdf";
    case "text":
      return contentType === "text/csv" ? "typeCsv" : "typeText";
    case "office":
    case "opendocument":
      return "typeDocument";
  }
}

function AttachmentRow({
  attachment,
  locale,
  addedBy,
  onRemove,
}: {
  readonly attachment: TaskAttachment;
  readonly locale: string;
  readonly addedBy: string;
  readonly onRemove: () => void;
}) {
  const t = useTranslations("TaskAttachments");
  const kind = isAttachmentType(attachment.contentType)
    ? attachmentTypes[attachment.contentType].kind
    : null;
  const content = fileContentPath(attachment.fileId);
  const opensInline = kind === "image" || kind === "pdf";
  return (
    <li
      className="flex flex-wrap items-start gap-3 rounded-card border border-line bg-surface p-3"
      data-testid="task-attachment"
    >
      {kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private, per-viewer authorized redirect; next/image would cache it for everyone
        <img
          src={content}
          referrerPolicy="no-referrer"
          decoding="async"
          alt={t("previewOf", { name: attachment.name })}
          loading="lazy"
          className="size-16 shrink-0 rounded-control border border-line object-cover"
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="break-words font-medium text-fg">
          <bdi>{attachment.name}</bdi>
        </p>
        <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
          <span>{t(typeLabelKey(attachment.contentType))}</span>
          <span>{formatBytes(attachment.size, locale)}</span>
          {attachment.fromSeries ? <span>{t("fromSeries")}</span> : null}
          <span>{t("addedBy", { person: addedBy })}</span>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {opensInline ? (
          <a
            href={content}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center px-2 text-body font-medium text-accent-fg underline"
            aria-label={t("openNamed", { name: attachment.name })}
          >
            {t("open")}
          </a>
        ) : null}
        <a
          href={`${content}?download=1`}
          className="inline-flex min-h-10 items-center px-2 text-body font-medium text-accent-fg underline"
          aria-label={t("downloadNamed", { name: attachment.name })}
        >
          {t("download")}
        </a>
        {attachment.canRemove ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={t("removeNamed", { name: attachment.name })}
          >
            {t("remove")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function ImpactText({ impact }: { readonly impact: AttachmentScopeImpact }) {
  const t = useTranslations("TaskAttachments");
  return (
    <ul className="flex flex-col gap-1 text-body" data-testid="attachment-impact">
      <li>{t("impactChanged", { count: impact.changed })}</li>
      {impact.kept > 0 ? <li>{t("impactKept", { count: impact.kept })}</li> : null}
      {impact.full > 0 ? <li>{t("impactFull", { count: impact.full })}</li> : null}
      {impact.completed > 0 ? <li>{t("impactCompleted", { count: impact.completed })}</li> : null}
    </ul>
  );
}

function ScopeChoice({
  scope,
  onChange,
  followingAllowed,
  removing,
}: {
  readonly scope: AttachmentScope;
  readonly onChange: (scope: AttachmentScope) => void;
  readonly followingAllowed: boolean;
  readonly removing: boolean;
}) {
  const t = useTranslations("TaskAttachments");
  const tTasks = useTranslations("Tasks");
  const name = useId();
  const options: AttachmentScope[] = [
    "this",
    ...(followingAllowed ? ["following" as const] : []),
    "series",
  ];
  const help = {
    this: removing ? t("scopeThisRemoveHelp") : t("scopeThisAddHelp"),
    following: removing ? t("scopeFollowingRemoveHelp") : t("scopeFollowingAddHelp"),
    series: removing ? t("scopeSeriesRemoveHelp") : t("scopeSeriesAddHelp"),
  } as const;
  const labels = {
    this: tTasks("scopeThis"),
    following: tTasks("scopeFollowing"),
    series: tTasks("scopeSeries"),
  } as const;
  return (
    <fieldset className="flex flex-col gap-1" data-testid="attachment-scope">
      <legend className="mb-1 text-body font-medium text-fg">{tTasks("scopeLegend")}</legend>
      {options.map((option) => (
        <RadioOption
          key={option}
          name={name}
          value={option}
          label={labels[option]}
          description={help[option]}
          checked={scope === option}
          onChange={() => {
            onChange(option);
          }}
        />
      ))}
    </fieldset>
  );
}

function ScopeDialog({
  taskId,
  title,
  confirmLabel,
  followingAllowed,
  onClose,
  onConfirm,
}: {
  readonly taskId: string;
  readonly title: string;
  readonly confirmLabel: string;
  readonly followingAllowed: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (scope: AttachmentScope) => void;
}) {
  const t = useTranslations("TaskAttachments");
  const tTasks = useTranslations("Tasks");
  const texts = useTaskTexts(memberNames([]));
  const [scope, setScope] = useState<AttachmentScope>("this");
  const preview = useQuery<{ impact: AttachmentScopeImpact }, TaskRequestError>({
    // Never cached (gcTime 0) and outside the `tasks` keys, like the S19 series previews.
    queryKey: ["task-attachment-preview", taskId, scope],
    queryFn: () =>
      sendTaskRequest("GET", `${TASKS_ENDPOINT}/${taskId}/attachments/impact?scope=${scope}`),
    enabled: scope !== "this",
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      closeLabel={tTasks("close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {tTasks("cancel")}
          </Button>
          <Button
            disabled={scope !== "this" && (preview.isPending || preview.isError)}
            onClick={() => {
              onConfirm(scope);
            }}
            data-testid="attachment-scope-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <ScopeChoice
        scope={scope}
        onChange={setScope}
        followingAllowed={followingAllowed}
        removing={false}
      />
      {scope !== "this" ? (
        <div
          className="rounded-card border border-line p-3"
          aria-live="polite"
          aria-busy={preview.isPending}
        >
          {preview.isPending ? (
            <p className="text-body text-fg-muted">{t("impactLoading")}</p>
          ) : preview.error ? (
            <p className="text-body text-danger">{texts.failure(preview.error.failure)}</p>
          ) : (
            <ImpactText impact={preview.data.impact} />
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

function RemoveDialog({
  attachment,
  allowSeries,
  followingAllowed,
  onClose,
  onRemoved,
  failureText,
  closeLabel,
}: {
  readonly attachment: TaskAttachment;
  readonly allowSeries: boolean;
  readonly followingAllowed: boolean;
  readonly onClose: () => void;
  readonly onRemoved: (name: string) => void;
  readonly failureText: (error: TaskRequestError) => string;
  readonly closeLabel: string;
}) {
  const t = useTranslations("TaskAttachments");
  const tTasks = useTranslations("Tasks");
  const [scope, setScope] = useState<AttachmentScope>("this");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TaskRequestError | null>(null);
  const endpoint = `${TASK_ATTACHMENTS_ENDPOINT}/${attachment.id}`;
  const preview = useQuery<AttachmentRemoveResponse, TaskRequestError>({
    queryKey: ["task-attachment-remove-preview", attachment.id, scope],
    queryFn: () => sendTaskRequest("DELETE", endpoint, { scope, dryRun: true }),
    enabled: scope !== "this",
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("removeTitle", { name: isolate(attachment.name) })}
      description={t("removeBody")}
      closeLabel={closeLabel}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {tTasks("cancel")}
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={scope !== "this" && (preview.isPending || preview.isError)}
            data-testid="attachment-remove-confirm"
            onClick={() => {
              setBusy(true);
              setError(null);
              sendTaskRequest<AttachmentRemoveResponse>("DELETE", endpoint, {
                scope,
                dryRun: false,
              })
                .then(() => {
                  onRemoved(attachment.name);
                })
                .catch((caught: unknown) => {
                  setBusy(false);
                  setError(
                    caught instanceof TaskRequestError ? caught : new TaskRequestError("failed"),
                  );
                });
            }}
          >
            {t("remove")}
          </Button>
        </>
      }
    >
      {allowSeries ? (
        <ScopeChoice
          scope={scope}
          onChange={setScope}
          followingAllowed={followingAllowed}
          removing
        />
      ) : attachment.fromSeries ? (
        <p className="text-body text-fg">{t("removeOnlyThis")}</p>
      ) : null}
      {scope !== "this" ? (
        <div
          className="rounded-card border border-line p-3"
          aria-live="polite"
          aria-busy={preview.isPending}
        >
          {preview.isPending ? (
            <p className="text-body text-fg-muted">{t("impactLoading")}</p>
          ) : preview.error ? (
            <p className="text-body text-danger">{failureText(preview.error)}</p>
          ) : preview.data.impact ? (
            <ImpactText impact={preview.data.impact} />
          ) : null}
        </div>
      ) : null}
      {error ? (
        <FormAlert tone="error" announce>
          {failureText(error)}
        </FormAlert>
      ) : null}
    </Dialog>
  );
}
