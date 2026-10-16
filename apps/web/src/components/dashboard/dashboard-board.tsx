"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { DashboardRequestError } from "@/dashboard/api";
import {
  applyTemplate,
  resetDashboard,
  saveDashboard,
  undoDashboard,
  type RevisionResponse,
} from "@/dashboard/api";
import type { DashboardLayout } from "@/dashboard/layout";
import type { DashboardTarget } from "@/dashboard/schema";
import type { SourceHome, WidgetEntry } from "@/dashboard/view-types";

import { DashboardEditor, type EditorAction } from "./dashboard-editor";
import { DashboardGrid } from "./dashboard-grid";
import { useFailureMessage } from "./use-failure-message";

type Notice =
  | { readonly kind: "saved" | "reset" | "undone" }
  | { readonly kind: "applied"; readonly dropped: number };

/**
 * A dashboard (S17): the widgets in normal use, and for people who may change it, Customize, which
 * opens edit mode. Whether someone may edit comes from the server (`canEdit`), and every change is
 * checked again by the API and the database; hiding the button is only a convenience.
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
  const router = useRouter();
  const hydrated = useHydrated();
  const failureMessage = useFailureMessage();
  const [refreshing, startRefresh] = useTransition();
  const [editing, setEditing] = useState(false);
  // The revision the open draft started from: a save only succeeds if nobody saved since.
  const [baseRevision, setBaseRevision] = useState(revision);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Leaving edit mode (saved, cancelled, reset …) returns keyboard focus to Customize once it is
  // usable again, instead of dropping it at the top of the page.
  const customizeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  const mutation = useMutation<RevisionResponse, DashboardRequestError, EditorAction>({
    mutationFn: (action) => {
      const expected = editing ? baseRevision : revision;
      switch (action.kind) {
        case "save":
          return saveDashboard(target, action.layout, expected);
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
      // Leave edit mode together with the fresh server render, so the saved layout replaces the
      // draft in one step.
      startRefresh(() => {
        setEditing(false);
        returnFocus.current = true;
        router.refresh();
      });
    },
    onError: (error) => {
      // Not permitted any more: the fresh render drops Customize. A conflict waits for "Load latest",
      // so the person's draft is not thrown away without them seeing why.
      if (error.failure === "notPermitted" || error.failure === "notFound") {
        startRefresh(() => {
          setEditing(false);
          returnFocus.current = true;
          router.refresh();
        });
      }
    },
  });

  const pending = mutation.isPending || refreshing;
  useEffect(() => {
    if (!returnFocus.current || editing || pending) return;
    returnFocus.current = false;
    customizeRef.current?.focus();
  }, [editing, pending]);

  function startEditing() {
    mutation.reset();
    setNotice(null);
    setBaseRevision(revision);
    setEditing(true);
  }

  function loadLatest() {
    mutation.reset();
    startRefresh(() => {
      setEditing(false);
      returnFocus.current = true;
      router.refresh();
    });
  }

  const error = mutation.error;
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
      {error ? (
        <FormAlert tone="error" announce>
          <p>{failureMessage(error.failure)}</p>
          {error.failure === "conflict" ? (
            <Button size="sm" variant="secondary" className="mt-2" onClick={loadLatest}>
              {t("loadLatest")}
            </Button>
          ) : null}
        </FormAlert>
      ) : null}

      {editing ? (
        <DashboardEditor
          target={target}
          initial={layout}
          entries={widgets}
          sourceHomes={sourceHomes}
          canUndo={canUndo}
          pending={pending}
          onAction={(action) => {
            mutation.mutate(action);
          }}
          onDone={() => {
            mutation.reset();
            setEditing(false);
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
                  onClick={startEditing}
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
          <DashboardGrid layout={layout} widgets={widgets} emptyState={emptyState} />
        </>
      )}
    </div>
  );
}
