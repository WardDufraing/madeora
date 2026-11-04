"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { eventEndpoint, sendCalendarRequest } from "@/calendar/api";
import { calendarPath, editEventPath } from "@/calendar/format";
import type { EventScope } from "@/calendar/schema";
import { previewSchema, type Preview } from "@/calendar/shapes";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { DateFormat } from "@/preferences/schema";
import { formatTaskDate } from "@/tasks/format";

import { CalendarFailureAlert } from "./calendar-failure";
import { useCalendarMutation } from "./use-calendar-mutation";

/**
 * Edit and Delete on an event's page (S32), only where the person may (the database decides
 * again). Deleting a recurring event asks which events: this one, this and following, or all; the
 * affected occurrences are listed before anything is deleted. "All events" (or a single event) goes
 * to the Home's or the person's 7-day trash; the other two cannot be restored.
 */
export function EventActions({
  homeId,
  eventHomeId,
  eventId,
  revision,
  recurring,
  on,
  canEdit,
  canDelete,
  dateFormat,
}: {
  /** The calendar it is shown in (where Delete returns to). */
  readonly homeId: string | null;
  /** The event's own Home, or null for a personal event: it is edited there. */
  readonly eventHomeId: string | null;
  readonly eventId: string;
  readonly revision: number;
  readonly recurring: boolean;
  /** The occurrence shown (a recurring event). */
  readonly on: string | null;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly dateFormat: DateFormat;
}) {
  const t = useTranslations("Calendar");
  const [open, setOpen] = useState(false);
  if (!canEdit && !canDelete) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {canEdit ? (
        <Link
          href={editEventPath(eventHomeId, eventId, recurring ? on : null)}
          className="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-body font-medium text-on-accent"
          data-testid="event-edit"
        >
          {t("edit")}
        </Link>
      ) : null}
      {canDelete ? (
        <Button
          variant="destructive"
          onClick={() => {
            setOpen(true);
          }}
          data-testid="event-delete"
        >
          {t("delete")}
        </Button>
      ) : null}
      {open ? (
        <DeleteDialog
          homeId={homeId}
          eventId={eventId}
          revision={revision}
          recurring={recurring}
          on={on}
          dateFormat={dateFormat}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function DeleteDialog({
  homeId,
  eventId,
  revision,
  recurring,
  on,
  dateFormat,
  onClose,
}: {
  readonly homeId: string | null;
  readonly eventId: string;
  readonly revision: number;
  readonly recurring: boolean;
  readonly on: string | null;
  readonly dateFormat: DateFormat;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Calendar");
  const scopeLabel = {
    only: t("scope_only"),
    following: t("scope_following"),
    all: t("scope_all"),
  } as const satisfies Record<EventScope, string>;
  const deletePreviewText = {
    only: t("deletePreview_only"),
    following: t("deletePreview_following"),
    all: t("deletePreview_all"),
  } as const satisfies Record<EventScope, string>;
  const router = useRouter();
  const [scope, setScope] = useState<EventScope>(on ? "only" : "all");
  const [preview, setPreview] = useState<Preview | null>(null);
  const remove = useCalendarMutation(
    `calendar-event:${eventId}`,
    (input: { dryRun: boolean }) =>
      sendCalendarRequest("DELETE", eventEndpoint(eventId), {
        revision,
        scope: recurring ? scope : null,
        on: recurring && scope !== "all" ? on : null,
        ...(input.dryRun ? { dryRun: true } : {}),
      }),
    (answer, input) => {
      if (input.dryRun) {
        const parsed = previewSchema.safeParse(answer);
        if (parsed.success) setPreview(parsed.data);
        return;
      }
      onClose();
      router.push(calendarPath(homeId));
    },
  );
  const date = (value: string) => formatTaskDate(value, { dateFormat });
  const trash = preview ? preview.trash === true : !recurring;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("deleteTitle")}
      description={recurring ? t("deleteRecurringDescription") : t("deleteTrashDescription")}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4" data-testid="event-delete-dialog">
        <CalendarFailureAlert error={remove.error} />
        {recurring ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-body font-semibold text-fg">{t("scopeLegend")}</legend>
            {(on ? (["only", "following", "all"] as const) : (["all"] as const)).map((value) => (
              <RadioOption
                key={value}
                name="delete-scope"
                value={value}
                label={scopeLabel[value]}
                checked={scope === value}
                onChange={() => {
                  setScope(value);
                  setPreview(null);
                }}
                data-testid={`delete-scope-${value}`}
              />
            ))}
          </fieldset>
        ) : null}
        {preview ? (
          <section className="flex flex-col gap-2" data-testid="event-delete-preview">
            <p className="text-body">{deletePreviewText[preview.scope]}</p>
            <ul className="list-disc ps-6 text-body">
              {preview.dates.map((value) => (
                <li key={value}>{date(value)}</li>
              ))}
            </ul>
            {preview.more || preview.endless ? (
              <p className="text-helper text-fg-muted">{t("previewMore")}</p>
            ) : null}
            <p className="text-body text-fg-muted">
              {trash ? t("deleteToTrash") : t("deleteNoTrash")}
            </p>
          </section>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          {recurring && !preview ? (
            <Button
              loading={remove.busy}
              onClick={() => {
                remove.mutate({ dryRun: true });
              }}
              data-testid="event-delete-review"
            >
              {t("reviewDelete")}
            </Button>
          ) : (
            <Button
              variant="destructive"
              loading={remove.busy}
              onClick={() => {
                remove.mutate({ dryRun: false });
              }}
              data-testid="event-delete-confirm"
            >
              {t("confirmDelete")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
