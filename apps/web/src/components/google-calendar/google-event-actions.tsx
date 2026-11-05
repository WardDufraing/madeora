"use client";

import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";

import { calendarPath } from "@/calendar/format";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  googleChangeEndpoint,
  googleEventEndpoint,
  sendGoogleRequest,
} from "@/google-calendar/api";
import type { GoogleScope } from "@/google-calendar/schema";
import type { GoogleChange, GoogleField, GoogleVersion } from "@/google-calendar/shapes";
import type { DateFormat } from "@/preferences/schema";
import { formatTaskDate } from "@/tasks/format";

import { Failure, useGoogleMutation } from "./google-calendar-actions";

/** The dry-run answer of a series change or deletion (S34). */
export const googlePreviewSchema = z.object({
  outcome: z.literal("preview"),
  count: z.int(),
  dates: z.array(z.string()),
  beyondWindow: z.boolean(),
});
export type GooglePreview = z.output<typeof googlePreviewSchema>;

/** The occurrences a series change affects, before the person confirms it. */
export function GooglePreviewList({
  preview,
  dateFormat,
  verb,
}: {
  readonly preview: GooglePreview;
  readonly dateFormat: DateFormat;
  readonly verb: "change" | "delete" | "remove";
}) {
  const t = useTranslations("GoogleCalendar");
  return (
    <section className="flex flex-col gap-2" data-testid="google-preview">
      <p className="text-body">{t(`preview_${verb}`, { count: preview.count })}</p>
      {preview.dates.length > 0 ? (
        <ul className="list-disc ps-6 text-body">
          {preview.dates.map((value, index) => (
            <li key={`${value}:${String(index)}`}>{formatTaskDate(value, { dateFormat })}</li>
          ))}
        </ul>
      ) : null}
      {preview.beyondWindow ? (
        <p className="text-helper text-fg-muted">{t("previewBeyondWindow")}</p>
      ) : null}
    </section>
  );
}

/**
 * Edit and Delete on the owner's Google event (S34). Edit only in a calendar Madeora may write to and while
 * no conflict waits; Delete always offers the two choices (Modules.md §4.2): "Remove from Madeora" (any
 * synced calendar; Google untouched) or "Delete everywhere" (writable calendars only, named).
 */
export function GoogleEventActions({
  homeId,
  eventId,
  revision,
  recurring,
  editable,
  calendar,
  conflict,
  dateFormat,
  editHref,
}: {
  readonly homeId: string | null;
  readonly eventId: string;
  readonly revision: number;
  readonly recurring: boolean;
  readonly editable: boolean;
  readonly calendar: string;
  readonly conflict: boolean;
  readonly dateFormat: DateFormat;
  readonly editHref: string;
}) {
  const t = useTranslations("GoogleCalendar");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      {editable && !conflict ? (
        <Link
          href={editHref}
          className="inline-flex min-h-10 items-center rounded-control bg-accent px-4 text-body font-medium text-on-accent"
          data-testid="google-event-edit"
        >
          {t("edit")}
        </Link>
      ) : null}
      {!conflict ? (
        <Button
          variant="destructive"
          onClick={() => {
            setOpen(true);
          }}
          data-testid="google-event-delete"
        >
          {t("delete")}
        </Button>
      ) : null}
      {open ? (
        <GoogleDeleteDialog
          homeId={homeId}
          eventId={eventId}
          revision={revision}
          recurring={recurring}
          editable={editable}
          calendar={calendar}
          dateFormat={dateFormat}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function GoogleDeleteDialog({
  homeId,
  eventId,
  revision,
  recurring,
  editable,
  calendar,
  dateFormat,
  onClose,
}: {
  readonly homeId: string | null;
  readonly eventId: string;
  readonly revision: number;
  readonly recurring: boolean;
  readonly editable: boolean;
  readonly calendar: string;
  readonly dateFormat: DateFormat;
  readonly onClose: () => void;
}) {
  const t = useTranslations("GoogleCalendar");
  const router = useRouter();
  const [scope, setScope] = useState<GoogleScope>("event");
  const [destination, setDestination] = useState<"madeora" | "everywhere" | null>(null);
  const [preview, setPreview] = useState<GooglePreview | null>(null);
  const remove = useGoogleMutation(
    `google-event:${eventId}`,
    async (input: { dryRun: boolean }) => {
      const answer = await sendGoogleRequest("DELETE", googleEventEndpoint(eventId), {
        scope,
        destination,
        revision,
        ...(input.dryRun ? { dryRun: true } : {}),
      });
      if (input.dryRun) {
        const parsed = googlePreviewSchema.safeParse(answer);
        if (parsed.success) setPreview(parsed.data);
        return;
      }
      onClose();
      if (answer.outcome === "removed") router.push(calendarPath(homeId));
    },
  );
  const needsPreview = scope !== "event";

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("deleteTitle")}
      description={t("deleteDescription")}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4" data-testid="google-delete-dialog">
        <Failure error={remove.error} about="event" />
        {recurring ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-body font-semibold text-fg">{t("scopeLegend")}</legend>
            {(["event", "following", "all"] as const).map((value) => (
              <RadioOption
                key={value}
                name="google-delete-scope"
                value={value}
                label={t(`scope_${value}`)}
                checked={scope === value}
                onChange={() => {
                  setScope(value);
                  setPreview(null);
                }}
                data-testid={`google-delete-scope-${value}`}
              />
            ))}
          </fieldset>
        ) : null}
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-body font-semibold text-fg">{t("destinationLegend")}</legend>
          <RadioOption
            name="google-delete-destination"
            value="madeora"
            label={t("destination_madeora")}
            description={t("destination_madeoraHint")}
            checked={destination === "madeora"}
            onChange={() => {
              setDestination("madeora");
              setPreview(null);
            }}
            data-testid="google-delete-madeora"
          />
          <RadioOption
            name="google-delete-destination"
            value="everywhere"
            label={t("destination_everywhere")}
            description={
              editable
                ? t("destination_everywhereHint", { calendar })
                : t("destination_everywhereReadOnly", { calendar })
            }
            disabled={!editable}
            checked={destination === "everywhere"}
            onChange={() => {
              setDestination("everywhere");
              setPreview(null);
            }}
            data-testid="google-delete-everywhere"
          />
        </fieldset>
        {preview ? (
          <GooglePreviewList
            preview={preview}
            dateFormat={dateFormat}
            verb={destination === "everywhere" ? "delete" : "remove"}
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          {needsPreview && !preview ? (
            <Button
              disabled={destination === null}
              loading={remove.busy}
              onClick={() => {
                remove.mutate({ dryRun: true });
              }}
              data-testid="google-delete-review"
            >
              {t("reviewDelete")}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={destination === null}
              loading={remove.busy}
              onClick={() => {
                remove.mutate({ dryRun: false });
              }}
              data-testid="google-delete-confirm"
            >
              {destination === "everywhere" ? t("confirmDeleteEverywhere") : t("confirmRemove")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function VersionValue({
  field,
  version,
}: {
  readonly field: GoogleField;
  readonly version: GoogleVersion | null;
}) {
  const t = useTranslations("GoogleCalendar");
  const format = useFormatter();
  if (version === null) return <>{t("versionDeletedMadeora")}</>;
  if (version.deleted) return <>{t("versionDeletedGoogle")}</>;
  if (field !== "time") {
    const value = version[field];
    return value ? <bdi className="whitespace-pre-line">{value}</bdi> : <>{t("versionEmpty")}</>;
  }
  if (version.allDay) {
    if (!version.startsOn) return <>{t("versionEmpty")}</>;
    const day = (value: string) =>
      format.dateTime(new Date(`${value}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
    const from = day(version.startsOn);
    const to = day(version.endsOn ?? version.startsOn);
    return (
      <>{from === to ? t("versionAllDay", { from }) : t("versionAllDayRange", { from, to })}</>
    );
  }
  if (!version.startsAt || !version.endsAt) return <>{t("versionEmpty")}</>;
  const options = {
    dateStyle: "medium",
    timeStyle: "short",
    ...(version.timeZone ? { timeZone: version.timeZone } : {}),
  } as const;
  return (
    <>
      {t("versionTimed", {
        start: format.dateTime(new Date(version.startsAt), options),
        end: format.dateTime(new Date(version.endsAt), options),
      })}
      {version.timeZone ? (
        <span className="block text-helper text-fg-muted">{version.timeZone}</span>
      ) : null}
    </>
  );
}

/**
 * The open change on the owner's event (S34): waiting to be saved, a failure with Try again and Discard,
 * or a conflict that shows both versions of every field changed on both sides and waits for the person's
 * choice. Nothing resolves a conflict on its own.
 */
export function GoogleChangePanel({
  change,
  calendar,
}: {
  readonly change: GoogleChange;
  readonly calendar: string;
}) {
  const t = useTranslations("GoogleCalendar");
  const act = useGoogleMutation(
    `google-change:${change.id}`,
    (
      input: { action: "resolve"; choice: "madeora" | "google" } | { action: "retry" | "discard" },
    ) => sendGoogleRequest("POST", googleChangeEndpoint(change.id), input),
  );
  const series = change.own ? "" : ` ${t("changeOnSeries")}`;

  if (change.state === "pending") {
    return (
      <p
        className="rounded-card border border-line bg-surface px-4 py-3 text-body"
        role="status"
        data-testid="google-change"
        data-state="pending"
      >
        {t(`pending_${change.action}`, { calendar })}
        {series}
      </p>
    );
  }

  if (change.state === "failed") {
    return (
      <section
        className="flex flex-col gap-3 rounded-card border border-danger bg-surface px-4 py-3"
        aria-labelledby="google-change-heading"
        data-testid="google-change"
        data-state="failed"
      >
        <h2 id="google-change-heading" className="text-body font-semibold">
          {t(`failed_${change.action}`, { calendar })}
          {series}
        </h2>
        <p className="text-body">
          {change.errorCode === "series_limit" ? t("failedSeriesLimit") : t("failedHint")}
        </p>
        <Failure error={act.error} about="event" />
        <div className="flex flex-wrap gap-2">
          {change.errorCode !== "series_limit" ? (
            <Button
              loading={act.busy}
              onClick={() => {
                act.mutate({ action: "retry" });
              }}
              data-testid="google-change-retry"
            >
              {t("retry")}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            loading={act.busy}
            onClick={() => {
              act.mutate({ action: "discard" });
            }}
            data-testid="google-change-discard"
          >
            {change.action === "create" ? t("discardCreate") : t("discard")}
          </Button>
        </div>
      </section>
    );
  }

  const fields: readonly GoogleField[] =
    change.conflictFields.length > 0 ? change.conflictFields : ["title"];
  const deletedInGoogle = change.theirs?.deleted === true;
  const deletedInMadeora = change.mine === null;
  const deletion = deletedInMadeora || deletedInGoogle;
  // The two choices, named for what they do when one side deleted the event.
  const [keepMine, keepTheirs] = deletedInGoogle
    ? (["restoreInGoogle", "acceptDeletion"] as const)
    : deletedInMadeora
      ? (["deleteAnyway", "keepEvent"] as const)
      : (["keepMadeora", "keepGoogle"] as const);
  return (
    <section
      className="flex flex-col gap-3 rounded-card border border-warning bg-surface px-4 py-3"
      aria-labelledby="google-change-heading"
      data-testid="google-change"
      data-state="conflict"
    >
      <h2 id="google-change-heading" className="text-body font-semibold">
        {t("conflictTitle")}
      </h2>
      <p className="text-body">
        {t("conflictText", { calendar })}
        {series}
      </p>
      <table className="w-full text-start text-body" data-testid="google-conflict-table">
        <thead>
          <tr className="text-helper text-fg-muted">
            <th scope="col" className="py-1 pe-3 text-start font-medium">
              <span className="sr-only">{t("conflictField")}</span>
            </th>
            <th scope="col" className="py-1 pe-3 text-start font-medium">
              {t("conflictMadeora")}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t("conflictGoogle")}
            </th>
          </tr>
        </thead>
        <tbody>
          {(deletion ? (["title"] as const) : fields).map((field) => (
            <tr key={field} className="border-t border-line align-top">
              <th scope="row" className="py-2 pe-3 text-start font-medium text-fg-muted">
                {t(`field_${field}`)}
              </th>
              <td className="py-2 pe-3" data-testid={`conflict-madeora-${field}`}>
                <VersionValue field={field} version={change.mine} />
              </td>
              <td className="py-2" data-testid={`conflict-google-${field}`}>
                <VersionValue field={field} version={change.theirs} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Failure error={act.error} about="event" />
      <div className="flex flex-wrap gap-2">
        <Button
          loading={act.busy}
          onClick={() => {
            act.mutate({ action: "resolve", choice: "madeora" });
          }}
          data-testid="google-keep-madeora"
        >
          {t(keepMine)}
        </Button>
        <Button
          variant="secondary"
          loading={act.busy}
          onClick={() => {
            act.mutate({ action: "resolve", choice: "google" });
          }}
          data-testid="google-keep-google"
        >
          {t(keepTheirs)}
        </Button>
      </div>
    </section>
  );
}
