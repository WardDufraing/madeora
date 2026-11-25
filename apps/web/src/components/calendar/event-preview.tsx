"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { calendarKeys, editEventPath } from "@/calendar/format";
import { eventEndpoint } from "@/calendar/api";
import { eventDetailSchema, type EventDetail } from "@/calendar/shapes";
import { Dialog } from "@/components/ui/dialog";
import { cx } from "@/components/ui/cx";

import { useCalendarClient } from "./calendar-client";
import { RepeatSummary } from "./repeat-summary";

export interface EventPreviewProps {
  /** The event's own page: where the link goes without JavaScript, and "Open full page". */
  readonly href: string;
  readonly eventId: string;
  /** A recurring event's occurrence date. */
  readonly on: string | null;
  readonly source: "madeora" | "google";
  readonly title: string;
  /** The time in words (translated and formatted by the server). */
  readonly when: string;
  readonly location: string | null;
  /** Context in words: shared by, repeats, from Google… */
  readonly notes: readonly string[];
  readonly workPeriod: boolean;
  /** What the trigger shows. */
  readonly children: ReactNode;
  readonly className?: string;
}

const NARROW = "(max-width: 40rem)";

function subscribeNarrow(callback: () => void) {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", callback);
  return () => {
    query.removeEventListener("change", callback);
  };
}

function plainClick(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/**
 * An event in the calendar that opens a compact preview (redesign decision 45). On a wide screen
 * the preview sits next to the event; on a phone it is a bottom sheet. It shows what the list
 * already knows at once, and "More details" reads the event itself (the person's own session, the
 * same read as its page) for the description, repeat, participants and the actions the person may
 * use. Without JavaScript, or with a modified click, the trigger is an ordinary link to the page.
 * The calendar underneath keeps its view, date, filters and scroll position.
 */
export function EventPreview(props: EventPreviewProps) {
  const t = useTranslations("Calendar");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
  const close = () => {
    setOpen(false);
  };
  const title = props.title || t("untitledGoogle");

  return (
    <>
      <Link
        ref={anchor}
        href={props.href}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={props.className}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        {props.children}
      </Link>
      {open && narrow ? (
        <Dialog
          open
          onClose={close}
          title={title}
          description={props.when}
          closeLabel={t("closeDialog")}
          size="sheet"
        >
          <PreviewBody {...props} onNavigate={close} />
        </Dialog>
      ) : null}
      {open && !narrow ? (
        <AnchoredPanel anchor={anchor} label={title} onClose={close}>
          <h3 className="text-body font-semibold text-fg">
            <bdi>{title}</bdi>
          </h3>
          <p className="text-body text-fg-muted">{props.when}</p>
          <PreviewBody {...props} onNavigate={close} />
        </AnchoredPanel>
      ) : null}
    </>
  );
}

/** A non-modal panel beside its trigger, kept inside the screen. */
function AnchoredPanel({
  anchor,
  label,
  onClose,
  children,
}: {
  readonly anchor: React.RefObject<HTMLElement | null>;
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useTranslations("Calendar");
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Positions the panel beside its trigger, and again whenever its size changes (the body grows
  // when "More details" opens or the event has loaded).
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const panel = ref.current;
    if (!trigger || !panel) return;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const margin = 8;
      const rtl = getComputedStyle(trigger).direction === "rtl";
      const wanted = rtl ? rect.right - width : rect.left;
      const left = Math.max(margin, Math.min(wanted, window.innerWidth - width - margin));
      const below = rect.bottom + 6;
      const top =
        below + height <= window.innerHeight - margin
          ? below
          : Math.max(margin, rect.top - height - 6);
      setPosition((current) =>
        current && current.top === top && current.left === left ? current : { top, left },
      );
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => {
      observer.disconnect();
    };
  }, [anchor]);

  useEffect(() => {
    const panel = ref.current;
    const trigger = anchor.current;
    const onClose = () => {
      closeRef.current();
    };
    panel?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel?.contains(target) || trigger?.contains(target)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      trigger?.focus();
    }
    // The page moved under a fixed panel: close it rather than leave it behind.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panel?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-testid="event-preview-panel"
      style={{
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      className="z-40 flex w-80 max-w-[calc(100vw-1rem)] animate-enter flex-col gap-2 rounded-card border border-line bg-surface-elevated p-4 text-fg shadow-overlay outline-none"
    >
      {children}
      <button
        type="button"
        onClick={onClose}
        className="sr-only focus:not-sr-only focus:self-end focus:rounded-control focus:px-3 focus:py-2 focus:text-body"
      >
        {t("closeDialog")}
      </button>
    </div>
  );
}

function PreviewBody({
  href,
  eventId,
  on,
  source,
  location,
  notes,
  workPeriod,
  onNavigate,
}: EventPreviewProps & { readonly onNavigate: () => void }) {
  const t = useTranslations("Calendar");
  const client = useCalendarClient();
  const [expanded, setExpanded] = useState(false);
  const readable = source === "madeora";
  const homeId = client?.homeId ?? null;
  const detail = useQuery({
    queryKey: [...calendarKeys.all, "event", eventId, on, homeId],
    enabled: readable,
    queryFn: async (): Promise<EventDetail> => {
      const params = new URLSearchParams();
      if (homeId) params.set("homeId", homeId);
      if (on) params.set("on", on);
      const query = params.toString();
      const response = await fetch(`${eventEndpoint(eventId)}${query ? `?${query}` : ""}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("event");
      const body: unknown = await response.json();
      const parsed = eventDetailSchema.safeParse(
        typeof body === "object" && body !== null && "event" in body ? body.event : null,
      );
      if (!parsed.success) throw new Error("event");
      return parsed.data;
    },
  });
  const event = detail.data;
  const shown = event ? (event.occurrence ?? event.series) : null;
  const names = client?.memberNames ?? {};

  return (
    <div className="flex flex-col gap-2" data-testid="event-preview">
      {workPeriod ? (
        <p className="text-helper font-medium text-fg-muted">{t("workLabel")}</p>
      ) : null}
      {location ? (
        <p className="text-body">
          <span className="text-fg-muted">{t("fieldLocation")}: </span>
          <bdi>{location}</bdi>
        </p>
      ) : null}
      {notes.length > 0 ? <p className="text-helper text-fg-muted">{notes.join(" · ")}</p> : null}

      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-line pt-2" data-testid="event-more">
          {detail.isPending && readable ? (
            <p className="text-helper text-fg-muted" role="status">
              {t("peekLoading")}
            </p>
          ) : null}
          {detail.isError ? (
            <p className="text-helper text-warning" role="status">
              {t("peekFailed")}
            </p>
          ) : null}
          {event && shown ? (
            <dl className="grid gap-x-3 gap-y-1 text-body sm:grid-cols-[auto_1fr]">
              {event.repeat ? (
                <>
                  <dt className="text-fg-muted">{t("repeatsLabel")}</dt>
                  <dd>
                    <RepeatSummary
                      repeat={event.repeat}
                      startsOn={event.series.startsOn}
                      dateFormat={client?.dateFormat ?? "dmy-slash"}
                    />
                  </dd>
                </>
              ) : null}
              {event.reminder !== null ? (
                <>
                  <dt className="text-fg-muted">{t("fieldReminder")}</dt>
                  <dd>{t("reminderBefore", { minutes: event.reminder })}</dd>
                </>
              ) : null}
              {homeId && shown.participants.length > 0 ? (
                <>
                  <dt className="text-fg-muted">{t("fieldParticipants")}</dt>
                  <dd>
                    <ul>
                      {shown.participants.map((id) => (
                        <li key={id}>
                          <bdi>{names[id] ?? t("memberUnnamed")}</bdi>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {shown?.description ? (
            <p className="whitespace-pre-line text-body">
              <bdi>{shown.description}</bdi>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        {event?.canEdit ? (
          <Link
            href={editEventPath(event.homeId, event.id, event.repeat ? on : null)}
            onClick={onNavigate}
            data-testid="event-preview-edit"
            className="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-body font-medium text-on-accent"
          >
            {t("edit")}
          </Link>
        ) : null}
        {readable ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((value) => !value);
            }}
            data-testid="event-preview-more"
            className="inline-flex min-h-10 items-center rounded-control px-3 text-body font-medium text-accent-fg underline"
          >
            {expanded ? t("peekFewerDetails") : t("peekMoreDetails")}
          </button>
        ) : null}
        <Link
          href={href}
          onClick={onNavigate}
          data-testid="event-preview-open"
          className={cx(
            "inline-flex min-h-10 items-center rounded-control px-3 text-body font-medium text-accent-fg underline",
          )}
        >
          {t("peekOpenPage")}
        </Link>
      </div>
    </div>
  );
}
