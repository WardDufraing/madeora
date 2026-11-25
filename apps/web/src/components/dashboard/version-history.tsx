"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { fetchHistory, type DashboardRequestError, type DashboardVersion } from "@/dashboard/api";
import { versionChange } from "@/dashboard/preview";
import type { DashboardTarget } from "@/dashboard/schema";
import type { WidgetType } from "@/dashboard/widgets";

import { LayoutPreviewView } from "./layout-preview";
import { useFailureMessage } from "./use-failure-message";
import { useWidgetLabels } from "./use-widget-labels";

/**
 * Typed query key of a dashboard's history. It names the dashboard, so one Home's history is never
 * shown for another; the whole cache is cleared on sign-out and identity changes (AuthSync).
 */
export function dashboardHistoryKey(target: DashboardTarget) {
  return ["dashboard", "history", target.kind === "home" ? target.homeId : "personal"] as const;
}

/**
 * The dashboard's version history (UX2c; redesign decision 32): its last committed layouts, newest
 * first, each with when and why it was saved, what changed, and a preview of the desktop and phone
 * arrangement. Restoring asks for confirmation first and is a new commit, so the layout it replaces
 * stays in the history and can be undone once. Loaded only while open, and fresh every time.
 */
export function VersionHistory({
  open,
  target,
  discardsChanges,
  pending,
  onClose,
  onRestore,
}: {
  readonly open: boolean;
  readonly target: DashboardTarget;
  /** Edit mode holds changes (or a resumed draft) that a restore would discard. */
  readonly discardsChanges: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  /** Restores `version`; `expectedRevision` is the current version this history showed. */
  readonly onRestore: (version: DashboardVersion, expectedRevision: number) => void;
}) {
  const t = useTranslations("DashboardHistory");
  const failureMessage = useFailureMessage();
  const [confirming, setConfirming] = useState<DashboardVersion | null>(null);
  const query = useQuery<readonly DashboardVersion[], DashboardRequestError>({
    queryKey: dashboardHistoryKey(target),
    queryFn: () => fetchHistory(target),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const versions = query.data ?? [];
  const current = versions.find((version) => version.isCurrent);

  function close() {
    setConfirming(null);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={confirming ? t("restoreTitle") : t("title")}
      {...(confirming ? {} : { description: t("description") })}
      closeLabel={t("close")}
      size="large"
      footer={
        confirming ? (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(null);
              }}
            >
              {t("back")}
            </Button>
            <Button
              disabled={pending || !current}
              onClick={() => {
                const version = confirming;
                setConfirming(null);
                if (current) onRestore(version, current.revision);
              }}
              data-testid="dashboard-history-restore-confirm"
            >
              {t("restoreAction")}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={close}>
            {t("close")}
          </Button>
        )
      }
    >
      {confirming ? (
        <RestoreConfirmation version={confirming} discardsChanges={discardsChanges} />
      ) : query.isPending ? (
        <p className="text-body text-fg-muted" role="status">
          {t("loading")}
        </p>
      ) : query.isError ? (
        <FormAlert tone="error" announce>
          {failureMessage(query.error.failure)}
        </FormAlert>
      ) : versions.length === 0 ? (
        <p className="text-body text-fg-muted">{t("empty")}</p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="dashboard-history">
          {versions.map((version, index) => (
            <li key={version.id}>
              <VersionRow
                version={version}
                showAuthor={target.kind === "home"}
                older={versions[index + 1] ?? null}
                pending={pending}
                onRestore={() => {
                  setConfirming(version);
                }}
              />
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

const reasonKey = {
  save: "reasonSave",
  undo: "reasonUndo",
  restore: "reasonRestore",
} as const satisfies Record<DashboardVersion["reason"], string>;

function useWhen() {
  const format = useFormatter();
  return (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
}

function VersionRow({
  version,
  showAuthor,
  older,
  pending,
  onRestore,
}: {
  readonly version: DashboardVersion;
  /** A Home's shared default: say whether the reader saved it (never who else did). */
  readonly showAuthor: boolean;
  readonly older: DashboardVersion | null;
  readonly pending: boolean;
  readonly onRestore: () => void;
}) {
  const t = useTranslations("DashboardHistory");
  const labels = useWidgetLabels();
  const when = useWhen();
  const headingId = useId();
  const previewId = useId();
  const [previewing, setPreviewing] = useState(false);
  const change = older ? versionChange(older.preview, version.preview) : null;
  const names = (types: readonly WidgetType[]) => types.map(labels.name).join(", ");

  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 text-fg"
      data-testid="dashboard-history-version"
      data-current={version.isCurrent ? "true" : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-body font-semibold">
          <time dateTime={version.createdAt}>{when(version.createdAt)}</time>
        </h3>
        {version.isCurrent ? (
          <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-helper font-medium">
            {t("current")}
          </span>
        ) : null}
      </div>
      <p className="text-helper text-fg-muted">
        {t(reasonKey[version.reason])}
        {showAuthor ? ` · ${version.savedByMe ? t("byYou") : t("byOther")}` : ""}
      </p>
      <ul className="flex flex-col gap-0.5 text-body">
        {change === null ? (
          <li>{t("oldest", { count: version.preview.widgets.length })}</li>
        ) : (
          <>
            {change.added.length > 0 ? (
              <li>{t("added", { widgets: names(change.added) })}</li>
            ) : null}
            {change.removed.length > 0 ? (
              <li>{t("removed", { widgets: names(change.removed) })}</li>
            ) : null}
            {change.rearranged ? <li>{t("rearranged")}</li> : null}
            {change.added.length === 0 && change.removed.length === 0 && !change.rearranged ? (
              <li>{t("unchanged")}</li>
            ) : null}
          </>
        )}
      </ul>
      {version.dropped ? <p className="text-helper text-fg-muted">{t("dropped")}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={previewing}
          aria-controls={previewId}
          onClick={() => {
            setPreviewing((value) => !value);
          }}
          data-testid="dashboard-history-preview"
        >
          {previewing ? t("hidePreview") : t("preview")}
        </Button>
        {version.isCurrent ? null : (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={onRestore}
            data-testid="dashboard-history-restore"
          >
            {t("restore")}
          </Button>
        )}
      </div>
      <div id={previewId} hidden={!previewing}>
        {previewing ? (
          <LayoutPreviewView
            preview={version.preview}
            label={t("previewLabel", { when: when(version.createdAt) })}
          />
        ) : null}
      </div>
    </article>
  );
}

function RestoreConfirmation({
  version,
  discardsChanges,
}: {
  readonly version: DashboardVersion;
  readonly discardsChanges: boolean;
}) {
  const t = useTranslations("DashboardHistory");
  const when = useWhen();
  return (
    <div className="flex flex-col gap-3 text-body" data-testid="dashboard-history-confirm">
      <p>{t("restoreConfirm", { when: when(version.createdAt) })}</p>
      <LayoutPreviewView
        preview={version.preview}
        label={t("previewLabel", { when: when(version.createdAt) })}
      />
      {version.dropped ? <p>{t("dropped")}</p> : null}
      {discardsChanges ? <p>{t("discardUnsaved")}</p> : null}
      <p>{t("restoreKeeps")}</p>
    </div>
  );
}
