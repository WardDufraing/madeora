"use client";

import { useMutation } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { Dialog } from "@/components/ui/dialog";
import { DashboardRequestError } from "@/dashboard/api";
import {
  applyTemplate,
  discardDraft,
  fetchDraft,
  resetDashboard,
  saveDashboard,
  undoDashboard,
  type DashboardDraft,
  type RevisionResponse,
} from "@/dashboard/api";
import type { DashboardLayout } from "@/dashboard/layout";
import type { DashboardTarget } from "@/dashboard/schema";
import type { SourceHome, WidgetEntry } from "@/dashboard/view-types";

import { DashboardEditor, type EditorAction } from "./dashboard-editor";
import { DashboardGrid } from "./dashboard-grid";
import { useFailureMessage } from "./use-failure-message";
import { WidgetSettingsDialog } from "./widget-settings-dialog";

type Notice =
  | { readonly kind: "saved" | "reset" | "undone" }
  | { readonly kind: "applied"; readonly dropped: number };

/** An open edit session (UX2b). */
interface Session {
  /** Remounts the editor for a fresh session. */
  readonly key: number;
  readonly initial: DashboardLayout;
  readonly resumed: boolean;
  /** The committed revision the draft builds on: Done succeeds only if nobody saved since. */
  readonly baseRevision: number;
  /** Bumped to make the editor run Done (after "Replace it with my version"). */
  readonly doneRequest: number;
}

/**
 * A dashboard (S17): the widgets in normal use, and for people who may change it, Customize, which
 * opens edit mode. Whether someone may edit comes from the server (`canEdit`), and every change is
 * checked again by the API and the database; hiding the button is only a convenience.
 *
 * Edit mode works on a recoverable server draft (UX2b; redesign decision 6). Opening it checks for
 * one and offers Resume draft or Discard draft; when the dashboard was committed since the draft
 * began (here or on another device) it says so, and resuming is the explicit choice to replace that
 * newer version on Done. Done commits and drops the draft in one transaction; a conflict keeps the
 * draft and offers the same choice again. Nothing is ever overwritten silently.
 */
export function DashboardBoard({
  target,
  layout,
  revision,
  canEdit,
  canUndo,
  dropped,
  widgets,
  sourceHomes,
  emptyState,
}: {
  readonly target: DashboardTarget;
  readonly layout: DashboardLayout;
  /** 0 while the starter layout shows (nothing saved yet). */
  readonly revision: number;
  readonly canEdit: boolean;
  readonly canUndo: boolean;
  /** Something stored could not be shown. */
  readonly dropped: boolean;
  readonly widgets: readonly WidgetEntry[];
  readonly sourceHomes: readonly SourceHome[];
  readonly emptyState: ReactNode;
}) {
  const t = useTranslations("Dashboard");
  const format = useFormatter();
  const router = useRouter();
  const hydrated = useHydrated();
  const failureMessage = useFailureMessage();
  const [refreshing, startRefresh] = useTransition();
  const [session, setSession] = useState<Session | null>(null);
  const editing = session !== null;
  const sessions = useRef(0);
  // A draft found when opening edit mode, waiting for Resume or Discard.
  const [found, setFound] = useState<DashboardDraft | null>(null);
  const [opening, setOpening] = useState(false);
  const [draftCheckFailed, setDraftCheckFailed] = useState(false);

  const [notice, setNotice] = useState<Notice | null>(null);
  // The widget whose settings panel is open (normal mode only).
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  // Leaving edit mode (saved, cancelled, reset …) returns keyboard focus to Customize once it is
  // usable again, instead of dropping it at the top of the page.
  const customizeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  const mutation = useMutation<RevisionResponse, DashboardRequestError, EditorAction>({
    mutationFn: (action) => {
      const expected = session ? session.baseRevision : revision;
      switch (action.kind) {
        case "save":
          // From edit mode this is Done: the draft goes with the commit.
          return saveDashboard(target, action.layout, expected, { commitDraft: editing });
        case "reset":
          return resetDashboard(target, expected);
        case "undo":
          return undoDashboard(target, expected);
        case "apply":
          return applyTemplate(
            target,
            expected,
            action.option.source === "built-in"
              ? { builtIn: action.option.builtIn }
              : { id: action.option.id },
          );
      }
    },
    onSuccess: (result, action) => {
      setNotice(
        action.kind === "apply"
          ? { kind: "applied", dropped: result.dropped ?? 0 }
          : {
              kind: action.kind === "save" ? "saved" : action.kind === "reset" ? "reset" : "undone",
            },
      );
      // A reset, template or undo from edit mode replaced the layout the draft was built on.
      if (editing && action.kind !== "save") void discardDraft(target).catch(() => undefined);
      // Leave edit mode together with the fresh server render, so the saved layout replaces the
      // draft in one step.
      startRefresh(() => {
        setSession(null);
        setSettingsFor(null);
        returnFocus.current = true;
        router.refresh();
      });
    },
    onError: (error) => {
      // Not permitted any more: the fresh render drops Customize. A conflict waits for "Load latest",
      // so the person's draft is not thrown away without them seeing why.
      if (error.failure === "notPermitted" || error.failure === "notFound") {
        startRefresh(() => {
          setSession(null);
          returnFocus.current = true;
          router.refresh();
        });
      }
    },
  });

  const pending = mutation.isPending || refreshing || opening;
  useEffect(() => {
    if (!returnFocus.current || editing || pending) return;
    returnFocus.current = false;
    customizeRef.current?.focus();
  }, [editing, pending]);

  function open(initial: DashboardLayout, resumed: boolean, baseRevision: number) {
    sessions.current += 1;
    setSession({ key: sessions.current, initial, resumed, baseRevision, doneRequest: 0 });
  }

  /** Customize: resume or discard a stored draft first, if there is one. */
  async function startEditing() {
    mutation.reset();
    setNotice(null);
    setDraftCheckFailed(false);
    setOpening(true);
    try {
      const draft = await fetchDraft(target);
      if (draft) setFound(draft);
      else open(layout, false, revision);
    } catch (error) {
      // Edit anyway; autosave says plainly whether a draft could be stored.
      if (!(error instanceof DashboardRequestError) || error.failure !== "signedOut") {
        setDraftCheckFailed(true);
      }
      open(layout, false, revision);
    } finally {
      setOpening(false);
    }
  }

  function resumeDraft(draft: DashboardDraft) {
    setFound(null);
    // When someone committed since, resuming builds on the newer revision: Done then replaces it,
    // which is the choice the person just made. The page refreshes so Cancel returns to it.
    const conflict = draft.baseRevision !== draft.currentRevision;
    open(draft.layout, true, conflict ? draft.currentRevision : draft.baseRevision);
    if (conflict) {
      startRefresh(() => {
        router.refresh();
      });
    }
  }

  async function discardFound() {
    setFound(null);
    await discardDraft(target).catch(() => undefined);
    open(layout, false, revision);
  }

  /** Commits from edit mode; resolves to whether it worked (the editor keeps its draft if not). */
  async function editorAction(action: EditorAction): Promise<boolean> {
    try {
      await mutation.mutateAsync(action);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * After a conflict on Done: keep this draft, replacing the newer version. The editor runs Done
   * again on the new revision, so its autosave is stopped first and cannot land after the commit.
   */
  function keepMine(current: number) {
    if (!session) return;
    mutation.reset();
    setSession({ ...session, baseRevision: current, doneRequest: session.doneRequest + 1 });
  }

  /** After a conflict on Done: drop this draft and show what was saved. */
  function discardMine() {
    mutation.reset();
    void discardDraft(target).catch(() => undefined);
    startRefresh(() => {
      setSession(null);
      returnFocus.current = true;
      router.refresh();
    });
  }

  function openSettings(widgetId: string) {
    mutation.reset();
    setNotice(null);
    setSettingsFor(widgetId);
  }

  /** Saves one widget's settings: the saved layout with only that widget's config replaced. */
  function applySettings(widgetId: string, config: Record<string, unknown>) {
    mutation.mutate({
      kind: "save",
      layout: {
        ...layout,
        widgets: layout.widgets.map((widget) =>
          widget.id === widgetId ? { ...widget, config } : widget,
        ),
      },
    });
  }

  function loadLatest() {
    mutation.reset();
    startRefresh(() => {
      setSession(null);
      setSettingsFor(null);
      returnFocus.current = true;
      router.refresh();
    });
  }

  const error = mutation.error;
  const settingsWidget = layout.widgets.find((widget) => widget.id === settingsFor);
  const settingsEntry = widgets.find((entry) => entry.id === settingsFor);
  const noticeText =
    notice?.kind === "saved"
      ? t("savedNotice")
      : notice?.kind === "reset"
        ? t("resetNotice")
        : notice?.kind === "undone"
          ? t("undoneNotice")
          : notice?.kind === "applied"
            ? `${t("appliedNotice")}${notice.dropped > 0 ? ` ${t("appliedDropped", { count: notice.dropped })}` : ""}`
            : null;

  return (
    <div className="flex flex-col gap-4" data-testid="dashboard">
      {error && !settingsFor ? (
        <FormAlert tone="error" announce>
          {editing && error.failure === "conflict" ? (
            <>
              <p>{t("conflictWhileEditing")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    keepMine(error.revision ?? 0);
                  }}
                  data-testid="dashboard-keep-mine"
                >
                  {t("conflictKeepMine")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={discardMine}
                  data-testid="dashboard-discard-mine"
                >
                  {t("conflictDiscardMine")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>{failureMessage(error.failure)}</p>
              {error.failure === "conflict" ? (
                <Button size="sm" variant="secondary" className="mt-2" onClick={loadLatest}>
                  {t("loadLatest")}
                </Button>
              ) : null}
            </>
          )}
        </FormAlert>
      ) : null}
      {draftCheckFailed && editing ? (
        <FormAlert tone="info">{t("draftCheckFailed")}</FormAlert>
      ) : null}

      <Dialog
        open={found !== null}
        onClose={() => {
          setFound(null);
          returnFocus.current = true;
        }}
        title={t("resumeTitle")}
        closeLabel={t("close")}
        footer={
          found ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  void discardFound();
                }}
                data-testid="dashboard-discard-draft"
              >
                {t("discardDraft")}
              </Button>
              <Button
                onClick={() => {
                  resumeDraft(found);
                }}
                data-testid="dashboard-resume-draft"
              >
                {t("resumeDraft")}
              </Button>
            </>
          ) : null
        }
      >
        {found ? (
          <div className="flex flex-col gap-3 text-body" data-testid="dashboard-resume-prompt">
            <p>
              {t("resumeBody", {
                saved: format.dateTime(new Date(found.updatedAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </p>
            {found.baseRevision !== found.currentRevision ? (
              <p data-testid="dashboard-draft-conflict">{t("resumeConflict")}</p>
            ) : null}
            <p className="text-helper text-fg-muted">
              {t("resumeKeptUntil", {
                expires: format.dateTime(new Date(found.expiresAt), { dateStyle: "medium" }),
              })}
            </p>
          </div>
        ) : null}
      </Dialog>

      {session ? (
        <DashboardEditor
          key={session.key}
          target={target}
          committed={layout}
          initial={session.initial}
          resumed={session.resumed}
          draftUnchecked={draftCheckFailed}
          baseRevision={session.baseRevision}
          doneRequest={session.doneRequest}
          entries={widgets}
          sourceHomes={sourceHomes}
          canUndo={canUndo}
          pending={pending}
          onAction={editorAction}
          onCancel={() => {
            mutation.reset();
            // Cancel discards the draft and goes back to the saved layout (decision 6).
            void discardDraft(target).catch(() => undefined);
            setSession(null);
            returnFocus.current = true;
          }}
        />
      ) : (
        <>
          {canEdit || noticeText ? (
            <div className="flex flex-wrap items-center gap-3">
              {canEdit ? (
                <Button
                  variant="secondary"
                  disabled={!hydrated || pending}
                  onClick={() => {
                    void startEditing();
                  }}
                  data-testid="dashboard-customize"
                  ref={customizeRef}
                >
                  {t("customize")}
                </Button>
              ) : null}
              {noticeText ? (
                <FormAlert tone="success" announce className="flex-1">
                  {noticeText}{" "}
                  {canEdit && canUndo && notice?.kind !== "undone" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={mutation.isPending}
                      onClick={() => {
                        mutation.mutate({ kind: "undo" });
                      }}
                      data-testid="dashboard-undo"
                    >
                      {t("undo")}
                    </Button>
                  ) : null}
                </FormAlert>
              ) : null}
            </div>
          ) : null}
          {dropped ? <FormAlert tone="info">{t("droppedNotice")}</FormAlert> : null}
          <DashboardGrid
            layout={layout}
            widgets={widgets}
            emptyState={emptyState}
            canEdit={canEdit}
            onSettings={openSettings}
            onCustomize={() => {
              void startEditing();
            }}
          />
          {settingsWidget && settingsEntry ? (
            <WidgetSettingsDialog
              key={settingsWidget.id}
              widget={settingsWidget}
              title={settingsEntry.title}
              contextHomeId={
                target.kind === "home" ? target.homeId : (settingsWidget.source?.homeId ?? null)
              }
              pending={pending}
              error={
                error ? (
                  <>
                    <p>{failureMessage(error.failure)}</p>
                    {error.failure === "conflict" ? (
                      <Button size="sm" variant="secondary" className="mt-2" onClick={loadLatest}>
                        {t("loadLatest")}
                      </Button>
                    ) : null}
                  </>
                ) : null
              }
              onApply={(config) => {
                applySettings(settingsWidget.id, config);
              }}
              onClose={() => {
                mutation.reset();
                setSettingsFor(null);
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
