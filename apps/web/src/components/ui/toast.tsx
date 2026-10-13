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
   * except errors, which stay. The timer pauses while the toast is hovered or focused.
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
}

// Tone is carried by the icon shape and the message itself, never by colour alone.
const toneStyle: Record<ToastTone, { readonly icon: IconComponent; readonly colour: string }> = {
  info: { icon: InfoIcon, colour: "text-info" },
  success: { icon: SuccessIcon, colour: "text-success" },
  warning: { icon: WarningIcon, colour: "text-warning" },
  error: { icon: ErrorIcon, colour: "text-danger" },
};

export function ToastProvider({ children, regionLabel, dismissLabel }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((options: ToastOptions) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((current) => [...current, { ...options, id }]);
    return id;
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const latest = toasts.at(-1);

  return (
    <ToastContext value={api}>
      {children}
      <section
        aria-label={regionLabel}
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-3 sm:start-auto sm:w-96"
      >
        {/* Screen readers hear each new message once, through regions that exist before it arrives.
            Errors interrupt; everything else waits politely. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {latest && latest.tone !== "error" ? <p key={latest.id}>{announcement(latest)}</p> : null}
        </div>
        <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
          {latest?.tone === "error" ? <p key={latest.id}>{announcement(latest)}</p> : null}
        </div>
        {toasts.length > 0 ? (
          <ol className="flex w-full flex-col gap-3">
            {toasts.map((toast) => (
              <Toast key={toast.id} toast={toast} dismissLabel={dismissLabel} onDismiss={dismiss} />
            ))}
          </ol>
        ) : null}
      </section>
    </ToastContext>
  );
}

function announcement(toast: ToastItem): string {
  return toast.description ? `${toast.title}. ${toast.description}` : toast.title;
}

interface ToastProps {
  readonly toast: ToastItem;
  readonly dismissLabel: string;
  readonly onDismiss: (id: number) => void;
}

function Toast({ toast, dismissLabel, onDismiss }: ToastProps) {
  const tone = toast.tone ?? "info";
  const duration =
    toast.duration === undefined
      ? tone === "error"
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
      className={cx(
        "pointer-events-auto flex w-full animate-enter items-start gap-3 rounded-card border border-line bg-surface-elevated p-4 text-fg shadow-overlay",
      )}
    >
      <Icon className={cx("mt-0.5 shrink-0", colour)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-medium">{toast.title}</p>
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
