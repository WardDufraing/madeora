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
  endUnlockHere,
  readDisplayBoard,
  resetDisplay,
  undoChoreOnDisplay,
} from "@/displays/api";
import type { DisplayBoard, DisplayBoardChore } from "@/displays/board";
import { displayColumns, widgetSpan, type DisplayWidget } from "@/displays/layout";

import { DisplayLockDialog } from "./display-lock-dialog";
import { DisplayChoreList, DisplayClock, DisplayOra, DisplayShopping } from "./display-widgets";

/** How often the display reads its board without a signal (also its heartbeat). */
const REFRESH_MS = 60_000;
/** Signals that arrive close together become one read. */
const SIGNAL_DELAY_MS = 300;
/** How long an offline display keeps its last board, read-only, before showing only the time. */
export const OFFLINE_KEEP_MS = 10 * 60_000;
/** Inactivity after which a member's selection and typed PIN are cleared. */
export const IDLE_RESET_MS = 60_000;
/** How often the ambient view moves its clock a little (static-image persistence). */
const AMBIENT_SHIFT_MS = 60_000;
const AMBIENT_SHIFTS = ["0px, 0px", "12px, -8px", "-10px, 10px", "8px, 12px"] as const;

const choreActions = { complete: completeChoreOnDisplay, undo: undoChoreOnDisplay };

/** `m:ss` for a countdown. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

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
 * - Protected-actions session (UX8a, decision 37): a member's matched PIN opens five minutes in
 *   which that member's PIN is not asked again on this display. The screen shows who is unlocked
 *   and for how long, with Lock now. It relocks when the time is up, on Lock now and when the
 *   display goes ambient; the server keeps the real expiry and checks every action.
 * - Ambient view (UX8a, decision 36): after the Home's ambient timing without a touch or key, only
 *   the time and date; a tap brings the dashboard back. Any selection, dialog and session are
 *   cleared on the way in.
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
  const [ambient, setAmbient] = useState(false);
  const [ambientShift, setAmbientShift] = useState(0);
  // Seconds left of the open protected-actions session, as the server last said (so the tablet's
  // clock does not matter), counted down here; null: none.
  const initialUnlockLeft = initialBoard.locked ? null : (initialBoard.unlock?.secondsLeft ?? null);
  const [unlockLeft, setUnlockLeft] = useState<number | null>(initialUnlockLeft);
  const unlockLeftRef = useRef<number | null>(initialUnlockLeft);
  const shownVersion = useRef(initialBoard.signalVersion);
  const lastActivity = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
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
    const left = result.board.locked ? null : (result.board.unlock?.secondsLeft ?? null);
    unlockLeftRef.current = left;
    setUnlockLeft(left);
    setConnection("online");
    setOfflineSince(null);
    setStale(false);
  }, []);

  const unlockedId =
    !board.locked && unlockLeft !== null ? (board.unlock?.membershipId ?? null) : null;
  const unlockedMember =
    unlockedId === null || board.locked
      ? null
      : (board.members.find((member) => member.membershipId === unlockedId) ??
        board.lockManagers.find((member) => member.membershipId === unlockedId) ??
        null);

  // Ends the session here and on the server (best effort: the server also ends it at expiry).
  const relock = useCallback(() => {
    unlockLeftRef.current = null;
    setUnlockLeft(null);
    void endUnlockHere().then(() => refresh());
  }, [refresh]);

  // The countdown, once a second while a session is open; at zero it relocks.
  const counting = unlockLeft !== null;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      const left = unlockLeftRef.current;
      if (left === null) return;
      if (left <= 1) {
        relock();
        return;
      }
      unlockLeftRef.current = left - 1;
      setUnlockLeft(left - 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [counting, relock]);

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

  // The ambient view after the Home's timing without a touch or key (also checked when the tablet
  // wakes up, since timers sleep with it). Going ambient clears selections, dialogs and the session.
  const ambientMs = board.ambientAfterSeconds * 1000;
  const enterAmbient = useCallback(() => {
    setAmbient(true);
    setResetKey((key) => key + 1);
    setLockOpen(false);
    if (unlockLeftRef.current !== null) void endUnlockHere();
    unlockLeftRef.current = null;
    setUnlockLeft(null);
  }, []);
  useEffect(() => {
    if (ambient) return;
    if (lastActivity.current === 0) lastActivity.current = Date.now();
    let timer = setTimeout(
      enterAmbient,
      Math.max(0, lastActivity.current + ambientMs - Date.now()),
    );
    const touch = () => {
      lastActivity.current = Date.now();
      clearTimeout(timer);
      timer = setTimeout(enterAmbient, ambientMs);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivity.current >= ambientMs) enterAmbient();
    };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ambient, ambientMs, enterAmbient]);

  // In the ambient view the clock moves a little every minute, without animation.
  useEffect(() => {
    if (!ambient) return;
    const timer = setInterval(() => {
      setAmbientShift((shift) => (shift + 1) % AMBIENT_SHIFTS.length);
    }, AMBIENT_SHIFT_MS);
    return () => {
      clearInterval(timer);
    };
  }, [ambient]);

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
        <h1 className="sr-only">{board.locked ? t("lockedTitle") : t("offlineTitle")}</h1>
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

  if (ambient) {
    return (
      <button
        type="button"
        className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 px-4 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        data-testid="display-ambient"
        onClick={() => {
          lastActivity.current = Date.now();
          setAmbient(false);
          void refresh();
        }}
      >
        <span className="sr-only">{t("ambientTitle")}</span>
        <span
          className="flex flex-col items-center gap-6"
          style={{ transform: `translate(${AMBIENT_SHIFTS[ambientShift] ?? "0px, 0px"})` }}
        >
          <DisplayClock timeZone={board.timeZone} clockFormat={clockFormat} />
        </span>
        <span className="text-helper text-fg-muted">{t("ambientHint")}</span>
        {status}
      </button>
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
            unlockedMembershipId={unlockedId}
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
      case "ora":
        return (
          <DisplayOra
            chores={board.chores.length}
            shoppingRemaining={board.shopping.reduce((sum, list) => sum + list.remaining, 0)}
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
        <h1 ref={headingRef} tabIndex={-1} className="text-page-title font-semibold text-fg">
          <bdi>{board.homeName}</bdi>
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          {status}
          {unlockedId !== null && unlockLeft !== null ? (
            <div
              className="flex items-center gap-3 rounded-control border border-line bg-accent-subtle px-3 py-1"
              data-testid="display-unlocked"
            >
              <p className="text-helper text-fg">
                {t("unlockedFor", {
                  name: unlockedMember?.name ?? t("unnamed"),
                  time: formatCountdown(unlockLeft),
                })}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  relock();
                  headingRef.current?.focus();
                }}
              >
                {t("lockNow")}
              </Button>
            </div>
          ) : null}
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
        unlockedMembershipId={unlockedId}
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
