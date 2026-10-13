"use client";

import {
  CloseIcon,
  ErrorIcon,
  InfoIcon,
  SuccessIcon,
  WarningIcon,
  type IconComponent,
} from "@madeora/icons";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cx } from "./cx";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastOptions {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  /** One optional action, for example Undo. Clicking it also dismisses the toast. */
  readonly action?: { readonly label: string; readonly onAction: () => void };
  /**
   * Milliseconds before it hides itself, or `null` to stay until dismissed. Defaults to 6000,
   * except errors and toasts with an action, which stay: people using a keyboard or screen reader
   * need time to reach the action (WCAG 2.2.1). The timer pauses while hovered or focused.
   */
  readonly duration?: number | null;
}

interface ToastItem extends ToastOptions {
  readonly id: number;
}

interface ToastApi {
  readonly show: (options: ToastOptions) => number;
  readonly dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const DEFAULT_TOAST_DURATION = 6000;

/** Shows short, non-blocking messages. Use inside a `ToastProvider`. */
export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (!api) throw new Error("useToast must be used inside a ToastProvider.");
  return api;
}

export interface ToastProviderProps {
  readonly children?: ReactNode;
  /** Accessible name of the toast region, for example "Notifications" (translated by the caller). */
  readonly regionLabel: string;
  /** Accessible name of each toast's dismiss button (translated by the caller). */
  readonly dismissLabel: string;
  /**
   * Optional words for each tone, for example { warning: "Warning" } (translated by the caller).
   * Screen readers hear them before the message, because the tone icon is decorative.
   */
  readonly toneLabels?: Readonly<Partial<Record<ToastTone, string>>>;
}

// Tone is carried by the icon shape and the message itself, never by colour alone.
const toneStyle: Record<ToastTone, { readonly icon: IconComponent; readonly colour: string }> = {
  info: { icon: InfoIcon, colour: "text-info" },
  success: { icon: SuccessIcon, colour: "text-success" },
  warning: { icon: WarningIcon, colour: "text-warning" },
  error: { icon: ErrorIcon, colour: "text-danger" },
};

interface Announcement {
  readonly id: number;
  readonly text: string;
  readonly assertive: boolean;
}

/** Announcements kept in the live regions; older ones are removed, which is not announced. */
const MAX_ANNOUNCEMENTS = 5;

export function ToastProvider({
  children,
  regionLabel,
  dismissLabel,
  toneLabels,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const nextId = useRef(1);
  const region = useRef<HTMLElement>(null);
  const current = useRef<ToastItem[]>([]);
  // Where focus was before it entered the toasts, and where it goes after a focused toast closes.
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<number | "return" | null>(null);

  useEffect(() => {
    current.current = toasts;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === null) return;
    const next =
      target === "return"
        ? returnFocus.current
        : region.current?.querySelector<HTMLElement>(
            `[data-toast-id="${String(target)}"] [data-toast-dismiss]`,
          );
    if (next?.isConnected) next.focus();
  }, [toasts]);

  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const remember = (event: FocusEvent) => {
      if (event.relatedTarget instanceof HTMLElement && !element.contains(event.relatedTarget)) {
        returnFocus.current = event.relatedTarget;
      }
    };
    element.addEventListener("focusin", remember);
    return () => {
      element.removeEventListener("focusin", remember);
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const list = current.current;
    const index = list.findIndex((toast) => toast.id === id);
    const element = region.current?.querySelector(`[data-toast-id="${String(id)}"]`);
    if (index !== -1 && element?.contains(document.activeElement)) {
      // Keep keyboard users in place: the neighbouring toast, or back where they came from.
      const neighbour = list[index + 1] ?? list[index - 1];
      pendingFocus.current = neighbour ? neighbour.id : "return";
    }
    setToasts((items) => items.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current;
      nextId.current += 1;
      const tone = options.tone ?? "info";
      const label = toneLabels?.[tone];
      const message = options.description
        ? `${options.title}. ${options.description}`
        : options.title;
      const text = label ? `${label}: ${message}` : message;
      setToasts((items) => [...items, { ...options, id }]);
      // Announced once, when shown. Dismissing a toast never changes what was announced.
      setAnnouncements((items) =>
        [...items, { id, text, assertive: tone === "error" }].slice(-MAX_ANNOUNCEMENTS),
      );
      return id;
    },
    [toneLabels],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <section
        ref={region}
        aria-label={regionLabel}
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-3 sm:start-auto sm:w-96"
      >
        {/* Screen readers hear each new message once, through regions that exist before it arrives.
            Only additions are read, so several toasts in a row are all announced. Errors interrupt;
            everything else waits politely. */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions"
          className="sr-only"
        >
          {announcements
            .filter((item) => !item.assertive)
            .map((item) => (
              <p key={item.id}>{item.text}</p>
            ))}
        </div>
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="false"
          aria-relevant="additions"
          className="sr-only"
        >
          {announcements
            .filter((item) => item.assertive)
            .map((item) => (
              <p key={item.id}>{item.text}</p>
            ))}
        </div>
        {toasts.length > 0 ? (
          <ol className="flex w-full flex-col gap-3">
            {toasts.map((toast) => (
              <Toast
                key={toast.id}
                toast={toast}
                dismissLabel={dismissLabel}
                toneLabel={toneLabels?.[toast.tone ?? "info"]}
                onDismiss={dismiss}
              />
            ))}
          </ol>
        ) : null}
      </section>
    </ToastContext>
  );
}

interface ToastProps {
  readonly toast: ToastItem;
  readonly dismissLabel: string;
  readonly toneLabel: string | undefined;
  readonly onDismiss: (id: number) => void;
}

function Toast({ toast, dismissLabel, toneLabel, onDismiss }: ToastProps) {
  const tone = toast.tone ?? "info";
  const duration =
    toast.duration === undefined
      ? tone === "error" || toast.action
        ? null
        : DEFAULT_TOAST_DURATION
      : toast.duration;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(duration);
  const { icon: Icon, colour } = toneStyle[tone];
  const item = useRef<HTMLLIElement>(null);

  // Pause while the pointer is over the toast or focus is inside it (WCAG 2.2.1).
  useEffect(() => {
    const element = item.current;
    if (!element) return;
    const enter = () => {
      setHovered(true);
    };
    const leave = () => {
      setHovered(false);
    };
    const focusIn = () => {
      setFocused(true);
    };
    const focusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget)))
        setFocused(false);
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusin", focusIn);
    element.addEventListener("focusout", focusOut);
    return () => {
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("focusin", focusIn);
      element.removeEventListener("focusout", focusOut);
    };
  }, []);

  useEffect(() => {
    if (remaining.current === null || hovered || focused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, remaining.current);
    return () => {
      clearTimeout(timer);
      if (remaining.current !== null)
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [hovered, focused, onDismiss, toast.id]);

  return (
    <li
      ref={item}
      data-toast-id={toast.id}
      className={cx(
        "pointer-events-auto flex w-full animate-enter items-start gap-3 rounded-card border border-line bg-surface-elevated p-4 text-fg shadow-overlay",
      )}
    >
      <Icon className={cx("mt-0.5 shrink-0", colour)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-medium">
          {toneLabel ? <span className="sr-only">{`${toneLabel}: `}</span> : null}
          {toast.title}
        </p>
        {toast.description ? (
          <p className="text-helper text-fg-muted">{toast.description}</p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onAction();
              onDismiss(toast.id);
            }}
            className="mt-1 self-start rounded-control text-body font-medium text-accent-fg underline-offset-4 hover:underline"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={dismissLabel}
        data-toast-dismiss=""
        onClick={() => {
          onDismiss(toast.id);
        }}
        className="-me-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
      >
        <CloseIcon size="sm" />
      </button>
    </li>
  );
}
