"use client";

import { PlusIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { newEventPath } from "@/calendar/format";
import { Dialog } from "@/components/ui/dialog";
import type { GoogleWriteTargets } from "@/google-calendar/data";
import type { DateFormat } from "@/preferences/schema";

import { EventForm, type EventFormHome, type EventFormMember } from "./event-form";

/** What the calendar's new-event dialog needs: the same data the new-event page loads. */
export interface CalendarCreateData {
  readonly defaultTimeZone: string;
  readonly timeZoneChoices: readonly string[];
  readonly members: readonly EventFormMember[];
  readonly homes: readonly EventFormHome[];
  readonly googleTargets: GoogleWriteTargets | null;
  /** Where a new event starts when no date was picked (today in the shown timezone). */
  readonly today: string;
}

interface CalendarClientValue {
  readonly homeId: string | null;
  readonly dateFormat: DateFormat;
  /** Names of a Home's members by membership id, for an event's participants. */
  readonly memberNames: Readonly<Record<string, string | null>>;
  /** Opens the new-event dialog, starting on `date`; `null` where the person may not add events. */
  readonly openCreate: ((date?: string) => void) | null;
}

const CalendarClientContext = createContext<CalendarClientValue | null>(null);

export function useCalendarClient(): CalendarClientValue | null {
  return useContext(CalendarClientContext);
}

/**
 * The calendar's client side (UX3b): one new-event dialog and the context the event previews read.
 * The dialog holds the same form as the `/calendar/new` page, which stays for deep links, but
 * opens over the calendar so the view, date, filters and scroll position are never lost. On a
 * phone it fills the screen.
 */
export function CalendarClient({
  homeId,
  dateFormat,
  memberNames,
  create,
  children,
}: {
  readonly homeId: string | null;
  readonly dateFormat: DateFormat;
  readonly memberNames: Readonly<Record<string, string | null>>;
  /** Absent where the person may not add events here. */
  readonly create: CalendarCreateData | null;
  readonly children: ReactNode;
}) {
  const t = useTranslations("Calendar");
  const [session, setSession] = useState<{ date: string; nonce: number } | null>(null);
  const [dirty, setDirty] = useState(false);

  const value = useMemo<CalendarClientValue>(
    () => ({
      homeId,
      dateFormat,
      memberNames,
      openCreate: create
        ? (date) => {
            setSession((current) => ({
              date: date ?? create.today,
              nonce: (current?.nonce ?? 0) + 1,
            }));
          }
        : null,
    }),
    [homeId, dateFormat, memberNames, create],
  );

  const close = () => {
    setSession(null);
    setDirty(false);
  };

  return (
    <CalendarClientContext value={value}>
      {children}
      {create ? (
        <Dialog
          open={session !== null}
          onClose={close}
          title={t("newEventTitle")}
          closeLabel={t("closeDialog")}
          size="large"
          dirty={dirty}
          discardPrompt={{
            title: t("discardTitle"),
            message: t("discardMessage"),
            discard: t("discardConfirm"),
            keep: t("discardKeep"),
          }}
          className="max-sm:m-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none max-sm:rounded-none"
        >
          {(requestClose) =>
            session ? (
              <EventForm
                key={session.nonce}
                homeId={homeId}
                defaultTimeZone={create.defaultTimeZone}
                timeZoneChoices={create.timeZoneChoices}
                members={create.members}
                homes={create.homes}
                dateFormat={dateFormat}
                initialDate={session.date}
                {...(create.googleTargets ? { googleTargets: create.googleTargets } : {})}
                onDone={close}
                onCancel={requestClose}
                onDirtyChange={setDirty}
              />
            ) : null
          }
        </Dialog>
      ) : null}
    </CalendarClientContext>
  );
}

const primaryClass =
  "inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-body font-medium text-on-accent";

/**
 * "New event". A link to the new-event page, so it still works without JavaScript or as a new tab;
 * a plain click opens the dialog over the calendar instead.
 */
export function NewEventButton({
  homeId,
  date,
  label,
}: {
  readonly homeId: string | null;
  readonly date?: string;
  readonly label: string;
}) {
  const client = useCalendarClient();
  return (
    <Link
      href={newEventPath(homeId, date)}
      className={primaryClass}
      data-testid="calendar-new-event"
      onClick={(event) => {
        const open = client?.openCreate;
        if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        open(date);
      }}
    >
      {label}
    </Link>
  );
}

/** A quiet "+" in a day's cell: adds an event on that day (shown on hover and focus). */
export function AddOnDayButton({
  homeId,
  date,
  label,
}: {
  readonly homeId: string | null;
  readonly date: string;
  /** Accessible name, e.g. "Add event on 4 November" (translated by the caller). */
  readonly label: string;
}) {
  const client = useCalendarClient();
  return (
    <Link
      href={newEventPath(homeId, date)}
      aria-label={label}
      title={label}
      data-testid="calendar-add-on-day"
      className="inline-flex size-8 items-center justify-center rounded-control text-fg-muted opacity-0 hover:bg-accent-subtle hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
      onClick={(event) => {
        const open = client?.openCreate;
        if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        open(date);
      }}
    >
      <PlusIcon size="sm" />
    </Link>
  );
}
