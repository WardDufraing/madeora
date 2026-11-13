"use client";

import { CloseIcon, ChevronDownIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";

import { cx } from "@/components/ui/cx";
import { homeIdFromPath } from "@/components/shell/nav-items";
import { paletteFor, type OraSettings } from "@/ora/settings";
import type { OraExpression } from "@/ora/types";

import { OraCharacter } from "./ora-character";
import { OraContent, type OraStatus } from "./ora-content";

export interface OraAssistantProps {
  /** The account the server confirmed; the assistant is remounted for another account. */
  readonly userId: string;
  readonly settings: OraSettings;
  /** The Homes the person belongs to now, for naming the context. */
  readonly homes: readonly { readonly id: string; readonly name: string }[] | null;
}

const SWIPE_CLOSE_DISTANCE = 80;

/**
 * Ora's persistent entry point and its surface (Ora design handoff; spec "persistent expandable
 * Ora access" and "responsive mobile bottom sheet"): a button at the bottom-right of every
 * signed-in page that opens a speech bubble above it on larger screens and a bottom sheet on
 * phones. It closes with its button, a click outside, Escape or a swipe down; focus goes to it on
 * opening and back to the button on closing. The surface stays mounted while closed, so the page
 * behind and Ora's own state survive navigation and reopening; it is not modal and never takes
 * over the page.
 */
export function OraAssistant({ userId, settings, homes }: OraAssistantProps) {
  const t = useTranslations("Ora");
  const pathname = usePathname();
  const router = useRouter();
  const homeId = homeIdFromPath(pathname);
  const homeName =
    homeId === null ? null : (homes?.find((home) => home.id === homeId)?.name ?? null);
  const palette = paletteFor(settings, homeId);

  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [greeting, setGreeting] = useState(0);
  const [status, setStatus] = useState<OraStatus>("idle");
  const [intro, setIntro] = useState(settings.intro);
  const surface = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ readonly startY: number; readonly pointerId: number } | null>(null);
  const titleId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setExpanded(false);
    if (returnFocus) launcher.current?.focus();
  }, []);

  function toggle() {
    if (open) {
      close(true);
      return;
    }
    setOpen(true);
    setEverOpened(true);
    setGreeting((count) => count + 1);
  }

  // Focus moves into the surface when it opens.
  useEffect(() => {
    if (open) surface.current?.focus();
  }, [open]);

  // Escape and a click or tap outside close it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (surface.current?.contains(target) || launcher.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  const onHandleDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    swipe.current = { startY: event.clientY, pointerId: event.pointerId };
  };
  const onHandleUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (start && event.clientY - start.startY > SWIPE_CLOSE_DISTANCE) close(true);
  };

  const expression: OraExpression =
    open && status === "working"
      ? "thinking"
      : open && status === "problem"
        ? "concerned"
        : open && greeting > 0
          ? "wave"
          : "idle";

  const contextLabel = homeId === null ? t("contextPersonal") : (homeName ?? t("contextThisHome"));
  return (
    <>
      {everOpened ? (
        <div
          ref={surface}
          id="ora-surface"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          hidden={!open}
          data-testid="ora-surface"
          className={cx(
            "fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-t-card border border-line bg-surface-elevated text-fg shadow-overlay focus:outline-none",
            "pb-[env(safe-area-inset-bottom)]",
            expanded ? "max-h-[90dvh]" : "max-h-[60dvh]",
            "md:inset-x-auto md:bottom-24 md:end-4 md:w-[22rem] md:max-h-[min(36rem,calc(100dvh-8rem))] md:rounded-card md:pb-0",
            open && "animate-enter",
          )}
        >
          <div
            className="flex h-6 shrink-0 touch-none items-center justify-center md:hidden"
            onPointerDown={onHandleDown}
            onPointerUp={onHandleUp}
            onPointerCancel={() => {
              swipe.current = null;
            }}
            data-testid="ora-sheet-handle"
          >
            <span aria-hidden="true" className="h-1 w-10 rounded-full bg-line-control" />
          </div>
          <div className="flex items-center gap-3 px-4 pb-2 pt-1 md:pt-4">
            <OraCharacter
              palette={palette}
              expression={expression}
              motion={settings.motion}
              replayKey={greeting}
              className="w-14 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-section-title font-semibold">
                {t("title")}
              </h2>
              <p className="truncate text-helper text-fg-muted" data-testid="ora-context">
                {t("context", { context: contextLabel })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setExpanded((value) => !value);
              }}
              aria-expanded={expanded}
              aria-label={expanded ? t("collapse") : t("expand")}
              className="inline-flex size-10 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg md:hidden"
            >
              <ChevronDownIcon className={cx(!expanded && "rotate-180")} />
            </button>
            <button
              type="button"
              onClick={() => {
                close(true);
              }}
              aria-label={t("close")}
              className="inline-flex size-10 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
            >
              <CloseIcon />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" key={homeId ?? "personal"}>
            <OraContent
              userId={userId}
              homeId={homeId}
              homeName={homeName}
              intro={intro}
              active={open}
              onIntroSettled={(state) => {
                setIntro(state);
                router.refresh();
              }}
              onNavigated={() => {
                close(false);
              }}
              onStatus={setStatus}
            />
          </div>
        </div>
      ) : null}
      <button
        ref={launcher}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={everOpened ? "ora-surface" : undefined}
        aria-label={open ? t("close") : t("open")}
        data-testid="ora-launcher"
        className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] end-4 z-40 inline-flex size-14 items-center justify-center rounded-full border border-line bg-surface-elevated shadow-overlay hover:bg-accent-subtle"
      >
        <OraCharacter
          palette={palette}
          expression="idle"
          motion={settings.motion}
          className="w-10"
        />
      </button>
    </>
  );
}
