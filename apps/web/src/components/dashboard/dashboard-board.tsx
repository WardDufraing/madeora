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
  restoreVersion,
  saveDashboard,
  undoDashboard,
  type DashboardDraft,
  type RevisionResponse,
} from "@/dashboard/api";
import type { DashboardLayout, DashboardWidget } from "@/dashboard/layout";
import type { DashboardTarget } from "@/dashboard/schema";
import { withSuggestions } from "@/dashboard/suggestions";
import type { HomeViews, SourceHome, WidgetEntry } from "@/dashboard/view-types";

import { DashboardEditor, type EditorAction } from "./dashboard-editor";
import { DashboardGrid } from "./dashboard-grid";
import { HomeViewLabel, SuggestionsNotice } from "./home-view-controls";
import { useFailureMessage } from "./use-failure-message";
import { WidgetSettingsDialog } from "./widget-settings-dialog";

type Notice =
  | { readonly kind: "saved" | "reset" | "undone" | "restored" }
  | { readonly kind: "applied"; readonly dropped: number }
  /** UX2d: the person's own view ended, or shared-default additions were dismissed. */
  | { readonly kind: "returned" | "dismissed" | "viewCreated" };

/** Which Home dashboard Customize edits (UX2d; decision 33). */
type EditChoice = "mine" | "default";

/** What an edit session starts from: the dashboard, what it holds now, and its revision. */
interface EditSource {
  readonly target: DashboardTarget;
  readonly committed: DashboardLayout;
  readonly revision: number;
  readonly canUndo: boolean;
}

/** An open edit session (UX2b). */
interface Session {
  /** Remounts the editor for a fresh session. */
  readonly key: number;
  /** The dashboard being edited: on a Home, "My Home view" or the shared default (UX2d). */
  readonly target: DashboardTarget;
  /** What that dashboard holds now, which Cancel returns to and unsaved changes are measured from. */
  readonly committed: DashboardLayout;
  readonly canUndo: boolean;
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
  homeViews = null,
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
  /** Home dashboards only: my view vs the shared default, and shared additions to suggest (UX2d). */
  readonly homeViews?: HomeViews | null;
}) {
  const t = useTranslations("Dashboard");
  const tViews = useTranslations("DashboardHomeViews");
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
  // What the person chose to edit while that draft waits for Resume or Discard (UX2d).
  const [pendingEdit, setPendingEdit] = useState<{
    source: EditSource;
    initial: DashboardLayout;
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const [draftCheckFailed, setDraftCheckFailed] = useState(false);

  const [notice, setNotice] = useState<Notice | null>(null);
  // The widget whose settings panel is open (normal mode only).
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  // Leaving edit mode (saved, cancelled, reset …) returns keyboard focus to Customize once it is
  // usable again, instead of dropping it at the top of the page.
  const customizeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // Widget settings outside edit mode save to the dashboard on screen when the person may edit it.
  // Otherwise (a member looking at the shared default) they start the person's own Home view from
  // it (UX2d): the shared default is never changed by someone who may not edit it.
  const canCustomize = canEdit || homeViews?.canHaveView === true;
  const settingsOrigin: { target: DashboardTarget; revision: number } =
    canEdit || !homeViews
      ? { target, revision }
      : { target: { kind: "home", homeId: homeViews.homeId, view: "mine" }, revision: 0 };

  const mutation = useMutation<RevisionResponse, DashboardRequestError, EditorAction>({
    mutationFn: (action) => {
      const expected = session ? session.baseRevision : settingsOrigin.revision;
      const where = session ? session.target : settingsOrigin.target;
      switch (action.kind) {
        case "save":
          // From edit mode this is Done: the draft goes with the commit.
          return saveDashboard(where, action.layout, expected, { commitDraft: editing });
        case "reset":
          return resetDashboard(where, expected);
        case "undo":
          return undoDashboard(where, expected);
        case "apply":
          return applyTemplate(
            where,
            expected,
            action.option.source === "built-in"
              ? { builtIn: action.option.builtIn }
              : { id: action.option.id },
          );
        case "restore":
          // Against the revision the history showed as current (UX2c), not the draft's base.
          return restoreVersion(where, action.versionId, action.expectedRevision);
      }
    },
    onSuccess: (result, action) => {
      // A widget setting changed by a member who may not edit the shared default starts their own
      // view; say so, because it detaches them from later shared-default layout changes.
      const createdView = !session && action.kind === "save" && !canEdit && homeViews !== null;
      setNotice(
        createdView
          ? { kind: "viewCreated" }
          : action.kind === "apply"
            ? { kind: "applied", dropped: result.dropped ?? 0 }
            : {
                kind:
                  action.kind === "save"
                    ? "saved"
                    : action.kind === "reset"
                      ? "reset"
                      : action.kind === "restore"
                        ? "restored"
                        : "undone",
              },
      );
      // A reset, template, restore or undo from edit mode replaced the layout the draft was built on.
      if (session && action.kind !== "save")
        void discardDraft(session.target).catch(() => undefined);
      // Leave edit mode together with the fresh server render, so the saved layout replaces the
      // draft in one step.
      startRefresh(() => {
        setSession(null);
        setSettingsFor(null);
        returnFocus.current = true;
        router.refresh();
      });
    },
    onError: (error, action) => {
      // Not permitted any more: the fresh render drops Customize. A conflict waits for "Load latest",
      // so the person's draft is not thrown away without them seeing why.
      // A history version that is gone (rotated out of the last 10 by newer saves) is not a lost
      // right: edit mode and its draft stay, and the history loads fresh when opened again.
      const versionGone = action.kind === "restore" && error.failure === "notFound";
      if (error.failure === "notPermitted" || (error.failure === "notFound" && !versionGone)) {
        startRefresh(() => {
          setSession(null);
          returnFocus.current = true;
          router.refresh();
        });
      }
    },
  });

  const busy = mutation.isPending || refreshing || opening;
  useEffect(() => {
    if (!returnFocus.current || editing || busy) return;
    returnFocus.current = false;
    customizeRef.current?.focus();
  }, [editing, busy]);

  /** What Customize edits for `choice` (UX2d), and the layout and revision it starts from. */
  function sourceFor(choice: EditChoice | null): EditSource {
    if (!homeViews || choice === null) {
      return { target, committed: layout, revision, canUndo };
    }
    const homeId = homeViews.homeId;
    if (choice === "mine") {
      const mineNow = homeViews.showing === "mine";
      return {
        target: { kind: "home", homeId, view: "mine" },
        committed: layout,
        // No view yet: it starts from the shared default on screen, as a new view (revision 0).
        revision: mineNow ? revision : 0,
        canUndo: mineNow && canUndo,
      };
    }
    const sharedNow = homeViews.showing === "default";
    return {
      target: { kind: "home", homeId },
      committed: sharedNow ? layout : homeViews.shared.layout,
      revision: sharedNow ? revision : homeViews.shared.revision,
      canUndo: sharedNow ? canUndo : homeViews.shared.canUndo,
    };
  }

  function open(
    source: EditSource,
    initial: DashboardLayout,
    resumed: boolean,
    baseRevision: number,
  ) {
    sessions.current += 1;
    setSession({
      key: sessions.current,
      target: source.target,
      committed: source.committed,
      canUndo: source.canUndo,
      initial,
      resumed,
      baseRevision,
      doneRequest: 0,
    });
  }

  /**
   * Customize: resume or discard a stored draft first, if there is one. On a Home, `choice` says
   * which dashboard (UX2d), and `additions` are shared-default widgets to add to the person's view.
   */
  async function startEditing(
    choice: EditChoice | null = null,
    additions: readonly DashboardWidget[] = [],
  ) {
    mutation.reset();
    setNotice(null);
    setDraftCheckFailed(false);
    setOpening(true);
    const source = sourceFor(choice);
    const initial = additions.length
      ? withSuggestions(source.committed, additions).layout
      : source.committed;
    try {
      const draft = await fetchDraft(source.target);
      if (draft) {
        setPendingEdit({ source, initial });
        setFound(draft);
      } else open(source, initial, false, source.revision);
    } catch (error) {
      // Edit anyway; autosave says plainly whether a draft could be stored.
      if (!(error instanceof DashboardRequestError) || error.failure !== "signedOut") {
        setDraftCheckFailed(true);
      }
      open(source, initial, false, source.revision);
    } finally {
      setOpening(false);
    }
  }

  /**
   * Customize edits the dashboard on screen (UX2d): the shared default for someone who may edit it,
   * otherwise the person's own Home view. The other one has its own labelled button, so the shared
   * default is never changed by a choice that was not clearly made.
   */
  function customize() {
    if (!homeViews) void startEditing();
    else if (homeViews.showing === "mine") void startEditing("mine");
    else void startEditing(homeViews.canEditShared ? "default" : "mine");
  }

  // The other dashboard, for someone who may edit both (UX2d).
  const otherChoice: EditChoice | null =
    homeViews?.canHaveView && homeViews.canEditShared
      ? homeViews.showing === "mine"
        ? "default"
        : "mine"
      : null;

  function resumeDraft(draft: DashboardDraft) {
    setFound(null);
    const source = pendingEdit?.source ?? sourceFor(null);
    setPendingEdit(null);
    // When someone committed since, resuming builds on the newer revision: Done then replaces it,
    // which is the choice the person just made. The page refreshes so Cancel returns to it.
    const conflict = draft.baseRevision !== draft.currentRevision;
    open(source, draft.layout, true, conflict ? draft.currentRevision : draft.baseRevision);
    if (conflict) {
      startRefresh(() => {
        router.refresh();
      });
    }
  }

  async function discardFound() {
    setFound(null);
    const choice = pendingEdit ?? { source: sourceFor(null), initial: layout };
    setPendingEdit(null);
    await discardDraft(choice.source.target).catch(() => undefined);
    open(choice.source, choice.initial, false, choice.source.revision);
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
    void discardDraft(session?.target ?? target).catch(() => undefined);
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
  // A restore against a history that changed since it loaded (UX2c): the version rotated out, or
  // someone saved. Edit mode stays; reopening the history shows the current versions.
  const restoreStale =
    editing &&
    mutation.variables?.kind === "restore" &&
    (error?.failure === "notFound" || error?.failure === "conflict");
  const settingsWidget = layout.widgets.find((widget) => widget.id === settingsFor);
  const settingsEntry = widgets.find((entry) => entry.id === settingsFor);
  const noticeText =
    notice?.kind === "saved"
      ? t("savedNotice")
      : notice?.kind === "reset"
        ? t("resetNotice")
        : notice?.kind === "undone"
          ? t("undoneNotice")
          : notice?.kind === "restored"
            ? t("restoredNotice")
            : notice?.kind === "viewCreated"
              ? tViews("viewCreatedNotice")
              : notice?.kind === "returned"
                ? tViews("returnedNotice")
                : notice?.kind === "dismissed"
                  ? tViews("dismissedNotice")
                  : notice?.kind === "applied"
                    ? `${t("appliedNotice")}${notice.dropped > 0 ? ` ${t("appliedDropped", { count: notice.dropped })}` : ""}`
                    : null;

  return (
    <div className="flex flex-col gap-4" data-testid="dashboard">
      {error && !settingsFor ? (
        <FormAlert tone="error" announce>
          {restoreStale ? (
            <p>{t("restoreStale")}</p>
          ) : editing && error.failure === "conflict" ? (
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
          setPendingEdit(null);
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
        <>
          {homeViews ? (
            <FormAlert tone="info" announce>
              <p data-testid="dashboard-editing-label">
                <strong className="font-semibold">
                  {session.target.kind === "home" && session.target.view === "mine"
                    ? tViews("editingMine")
                    : tViews("editingShared")}
                </strong>{" "}
                {session.target.kind === "home" && session.target.view === "mine"
                  ? tViews("editingMineHint")
                  : tViews("editingSharedHint")}
              </p>
            </FormAlert>
          ) : null}
          <DashboardEditor
            key={session.key}
            target={session.target}
            committed={session.committed}
            initial={session.initial}
            resumed={session.resumed}
            draftUnchecked={draftCheckFailed}
            baseRevision={session.baseRevision}
            doneRequest={session.doneRequest}
            entries={widgets}
            sourceHomes={sourceHomes}
            canUndo={session.canUndo}
            pending={busy}
            onAction={editorAction}
            onCancel={() => {
              mutation.reset();
              // Cancel discards the draft and goes back to the saved layout (decision 6).
              void discardDraft(session.target).catch(() => undefined);
              setSession(null);
              returnFocus.current = true;
            }}
          />
        </>
      ) : (
        <>
          {homeViews ? (
            <HomeViewLabel
              views={homeViews}
              busy={busy || !hydrated}
              onReturned={() => {
                setNotice({ kind: "returned" });
                startRefresh(() => {
                  router.refresh();
                });
              }}
            />
          ) : null}
          {homeViews ? (
            <SuggestionsNotice
              views={homeViews}
              layout={layout}
              busy={busy || !hydrated}
              onAdd={(additions) => {
                void startEditing("mine", additions);
              }}
              onDismissed={() => {
                setNotice({ kind: "dismissed" });
                startRefresh(() => {
                  router.refresh();
                });
              }}
            />
          ) : null}
          {canCustomize || noticeText ? (
            <div className="flex flex-wrap items-center gap-3">
              {canCustomize ? (
                <Button
                  variant="secondary"
                  disabled={!hydrated || busy}
                  onClick={customize}
                  data-testid="dashboard-customize"
                  ref={customizeRef}
                >
                  {t("customize")}
                </Button>
              ) : null}
              {canCustomize && otherChoice ? (
                <Button
                  variant="ghost"
                  disabled={!hydrated || busy}
                  onClick={() => {
                    void startEditing(otherChoice);
                  }}
                  data-testid="dashboard-customize-other"
                >
                  {otherChoice === "mine" ? tViews("startMine") : tViews("editShared")}
                </Button>
              ) : null}
              {noticeText ? (
                <FormAlert tone="success" announce className="flex-1">
                  {noticeText}{" "}
                  {canEdit &&
                  canUndo &&
                  notice?.kind !== "undone" &&
                  notice?.kind !== "returned" &&
                  notice?.kind !== "dismissed" &&
                  notice?.kind !== "viewCreated" ? (
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
            canEdit={canCustomize}
            onSettings={openSettings}
            onCustomize={customize}
          />
          {settingsWidget && settingsEntry ? (
            <WidgetSettingsDialog
              key={settingsWidget.id}
              widget={settingsWidget}
              title={settingsEntry.title}
              contextHomeId={
                target.kind === "home" ? target.homeId : (settingsWidget.source?.homeId ?? null)
              }
              pending={busy}
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
