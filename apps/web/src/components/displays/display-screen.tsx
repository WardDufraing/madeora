"use client";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { DISPLAY_PATH } from "@/auth/redirects";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";
import { HouseholdChores } from "@/components/child-sign-in/household-chores";
import { Button } from "@/components/ui/button";
import {
  completeChoreOnDisplay,
  readDisplayBoard,
  resetDisplay,
  undoChoreOnDisplay,
} from "@/displays/api";
import type { DisplayBoard, DisplayBoardChore } from "@/displays/board";
import { displayColumns, widgetSpan, type DisplayWidget } from "@/displays/layout";

import { DisplayLockDialog } from "./display-lock-dialog";
import { DisplayChoreList, DisplayClock, DisplayShopping } from "./display-widgets";

/** How often the display reads its board without a signal (also its heartbeat). */
const REFRESH_MS = 60_000;
/** Signals that arrive close together become one read. */
const SIGNAL_DELAY_MS = 300;
/** How long an offline display keeps its last board, read-only, before showing only the time. */
export const OFFLINE_KEEP_MS = 10 * 60_000;
/** Inactivity after which a member's selection and typed PIN are cleared. */
export const IDLE_RESET_MS = 60_000;

const choreActions = { complete: completeChoreOnDisplay, undo: undoChoreOnDisplay };

function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(orientation: portrait)");
    const update = () => {
      setPortrait(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);
  return portrait;
}

/**
 * A paired Household Display (S44; spec "Confirmed dedicated household display identity and privacy
 * lock screen", "Confirmed independent layouts", "Confirmed member-only actions").
 *
 * - Normal mode: the display's own layout of shared-display-safe widgets, in its own orientation,
 *   theme, density and clock format. Members complete chores with the S42 PIN rules; the selection
 *   and any typed PIN are cleared after each action and after a minute without a touch.
 * - Locked (privacy/party mode): only the time, the date and the manager's welcome message. Nothing
 *   here unlocks it; the server sends nothing else while it is locked.
 * - The board is read again when the display's Realtime signal moves (its own row only) and every
 *   minute. Delivery is not trusted, so the minute read also reconciles a missed signal.
 * - Offline: the last board stays, read-only and marked, for ten minutes; then only the time. It is
 *   never written to browser storage, and no action claims success while offline.
 * - Revoked or its Home closed: it clears the screen at once and returns to the pairing screen.
 */
export function DisplayScreen({ initialBoard }: { readonly initialBoard: DisplayBoard }) {
  const t = useTranslations("DisplayBoard");
  const locale = useLocale();
  const [board, setBoard] = useState(initialBoard);
  const [connection, setConnection] = useState<"online" | "offline" | "leaving">("online");
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const shownVersion = useRef(initialBoard.signalVersion);
  const devicePortrait = usePortrait();

  const refresh = useCallback(async () => {
    const result = await readDisplayBoard();
    if (result.kind === "not-paired") {
      setConnection("leaving");
      await resetDisplay();
      window.location.replace(DISPLAY_PATH);
      return;
    }
    if (result.kind === "offline") {
      setConnection("offline");
      setOfflineSince((since) => since ?? Date.now());
      return;
    }
    shownVersion.current = result.board.signalVersion;
    setBoard(result.board);
    setConnection("online");
    setOfflineSince(null);
    setStale(false);
  }, []);

  // Every minute, and when the tablet wakes up or comes back online.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  // The display's own Realtime signal (RLS: only this display's live session sees its row).
  const displayId = board.displayId;
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const channel = supabase
      .channel(`display:${displayId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "display_signals",
          filter: `display_id=eq.${displayId}`,
        },
        (payload) => {
          const next: unknown = (payload.new as Record<string, unknown> | undefined)?.version;
          if (typeof next === "number" && next <= shownVersion.current) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (active) void refresh();
          }, SIGNAL_DELAY_MS);
        },
      )
      .subscribe((status) => {
        // (Re)connected: something may have been missed meanwhile.
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED && active) void refresh();
      });
    return () => {
      active = false;
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [displayId, refresh]);

  // Offline for too long: only the time is shown (nothing household-related stays on screen).
  useEffect(() => {
    if (offlineSince === null) return;
    const left = Math.max(0, offlineSince + OFFLINE_KEEP_MS - Date.now());
    const timer = setTimeout(() => {
      setStale(true);
    }, left);
    return () => {
      clearTimeout(timer);
    };
  }, [offlineSince]);

  // A minute without a touch or key: forget any member selection and typed PIN.
  useEffect(() => {
    const idle = () => {
      setResetKey((key) => key + 1);
      setLockOpen(false);
    };
    let timer = setTimeout(idle, IDLE_RESET_MS);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(idle, IDLE_RESET_MS);
    };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, []);

  // The display's own theme, independent of anyone's preference on this browser.
  const theme = board.preferences.theme;
  useEffect(() => {
    const root = document.documentElement;
    const before = root.getAttribute("data-theme");
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    return () => {
      if (before === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", before);
    };
  }, [theme]);

  if (connection === "leaving") {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("notPairedAnyMore")}
      </p>
    );
  }

  const status = (
    <p role="status" className="text-helper text-fg-muted" data-testid="display-connection">
      {connection === "offline" ? t("offline") : null}
    </p>
  );
  const clockFormat = board.preferences.clockFormat;

  if (board.locked || stale) {
    return (
      <div
        className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 px-4 text-center"
        data-testid={board.locked ? "display-locked" : "display-offline"}
      >
        <DisplayClock timeZone={board.timeZone} clockFormat={clockFormat} />
        {board.locked && board.lockMessage ? (
          <p className="text-section-title text-fg" dir="auto">
            {board.lockMessage}
          </p>
        ) : null}
        {board.locked ? (
          <p className="max-w-md text-helper text-fg-muted">{t("lockedHint")}</p>
        ) : null}
        {status}
      </div>
    );
  }

  const orientation =
    board.preferences.orientation === "auto"
      ? devicePortrait
        ? "portrait"
        : "landscape"
      : board.preferences.orientation;
  const columns = displayColumns(orientation);
  const compact = board.preferences.density === "compact";
  const offline = connection === "offline";
  const dueLabel = (chore: DisplayBoardChore): string =>
    chore.overdue
      ? t("overdue", {
          date: new Intl.DateTimeFormat(locale, {
            day: "numeric",
            month: "short",
            timeZone: "UTC",
          }).format(new Date(`${chore.dueDate}T00:00:00Z`)),
        })
      : t("dueToday");

  const widgetBody = (widget: DisplayWidget) => {
    switch (widget.type) {
      case "clock":
        return (
          <DisplayClock
            timeZone={board.timeZone}
            clockFormat={clockFormat}
            showDate={widget.config.showDate}
            size={widget.size === "small" ? "medium" : "large"}
          />
        );
      case "chores":
        return widget.config.actions && board.actions && !offline ? (
          <HouseholdChores
            key={resetKey}
            requirePin={board.requirePin}
            members={board.members}
            chores={board.chores.slice(0, widget.config.count).map((chore) => ({
              occurrenceId: chore.occurrenceId,
              title: chore.title,
              dueLabel: dueLabel(chore),
              overdue: chore.overdue,
              assigneeIds: chore.assigneeIds,
              mandatoryOpen: chore.mandatoryOpen,
              requiresApproval: chore.requiresApproval,
              requiresPin: chore.requiresPin,
            }))}
            actions={choreActions}
            onChanged={() => void refresh()}
          />
        ) : (
          <DisplayChoreList chores={board.chores} count={widget.config.count} dueLabel={dueLabel} />
        );
      case "shopping":
        return (
          <DisplayShopping
            lists={board.shopping}
            listIds={widget.config.listIds}
            count={widget.config.count}
          />
        );
    }
  };

  const titleOf = (widget: DisplayWidget): string | null =>
    widget.type === "clock" ? null : t(`widget.${widget.type}`);

  return (
    <div
      className={`flex w-full flex-col ${compact ? "gap-3 p-3" : "gap-5 p-5"}`}
      data-testid="display-board"
      data-orientation={orientation}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 text-start">
        <h1 className="text-page-title font-semibold text-fg">
          <bdi>{board.homeName}</bdi>
        </h1>
        <div className="flex items-center gap-3">
          {status}
          {board.lockManagers.length > 0 && !offline ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setLockOpen(true);
              }}
            >
              {t("lock")}
            </Button>
          ) : null}
        </div>
      </header>
      {offline ? <p className="text-helper text-fg-muted">{t("offlineReadOnly")}</p> : null}
      <div
        className={`grid grid-cols-1 sm:[grid-template-columns:repeat(var(--display-columns),minmax(0,1fr))] ${compact ? "gap-3" : "gap-5"} [grid-auto-flow:dense]`}
        style={{ "--display-columns": columns } as CSSProperties}
      >
        {board.layout.widgets.map((widget) => {
          const span = widgetSpan(widget.size, columns);
          const title = titleOf(widget);
          return (
            <section
              key={widget.id}
              aria-label={title ?? t("widget.clock")}
              className={`flex min-w-0 flex-col gap-3 overflow-hidden rounded-card border border-line bg-surface ${compact ? "p-3" : "p-5"} sm:[grid-column:span_var(--span-columns)] sm:[grid-row:span_var(--span-rows)]`}
              style={
                {
                  "--span-columns": span.columns,
                  "--span-rows": span.rows,
                } as CSSProperties
              }
              data-testid={`display-widget-${widget.type}`}
            >
              {title ? (
                <h2 className="text-section-title font-semibold text-fg text-start">{title}</h2>
              ) : null}
              {widgetBody(widget)}
            </section>
          );
        })}
      </div>
      <p className="text-helper text-fg-muted">{t("pairedAs", { name: board.displayName })}</p>
      <DisplayLockDialog
        key={resetKey}
        open={lockOpen}
        managers={board.lockManagers}
        onClose={() => {
          setLockOpen(false);
        }}
        onLocked={() => {
          setLockOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}
