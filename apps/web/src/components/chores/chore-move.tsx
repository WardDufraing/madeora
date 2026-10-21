"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreAgendaItem,
  type OccurrenceImpact,
} from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

interface MoveAnswer {
  readonly outcome: "preview" | "saved";
  readonly impact: OccurrenceImpact | null;
  readonly revision: number | null;
}

export interface ChoreMoveProps {
  /** The occurrence being moved, or null when the dialog is closed. */
  readonly item: ChoreAgendaItem | null;
  /** A date to start with (a drop on a day), or null for the occurrence's own. */
  readonly targetDate: string | null;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  readonly onClose: () => void;
}

const KEEP = "keep";

/**
 * Moving one occurrence to another date and/or member (S21; spec "Confirmed chore calendar and
 * rescheduling"; chore managers). The keyboard and touch way, and where a drag ends: choose the
 * date and assignee, preview what changes (old and new date and assignee, whether it becomes
 * overdue, personal reminders that move or end, an open handover or volunteer request that ends),
 * then confirm at the revision seen. Only this occurrence changes; the series and rotation stay.
 */
export function ChoreMove({ item, targetDate, members, formats, onClose }: ChoreMoveProps) {
  if (!item?.id || item.revision === null) return null;
  return (
    <MoveDialog
      key={`${item.id}:${targetDate ?? ""}`}
      item={item}
      occurrenceId={item.id}
      revision={item.revision}
      targetDate={targetDate}
      members={members}
      formats={formats}
      onClose={onClose}
    />
  );
}

function MoveDialog({
  item,
  occurrenceId,
  revision,
  targetDate,
  members,
  formats,
  onClose,
}: Omit<ChoreMoveProps, "item"> & {
  readonly item: ChoreAgendaItem;
  readonly occurrenceId: string;
  readonly revision: number;
}) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const { announce, region } = useAnnouncer();
  const [date, setDate] = useState(targetDate ?? item.date);
  const [assignee, setAssignee] = useState(KEEP);
  const [preview, setPreview] = useState<MoveAnswer | null>(null);
  const [nothing, setNothing] = useState(false);
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    (input: { readonly dryRun: boolean }) =>
      sendChoreRequest<MoveAnswer>("PATCH", `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}`, {
        expectedRevision: revision,
        dryRun: input.dryRun,
        // Confirming the preview confirms the immediate release it named.
        ...(!input.dryRun && preview?.impact?.releaseNow ? { confirmRelease: true } : {}),
        ...(date !== item.date ? { dueDate: date } : {}),
        ...(assignee !== KEEP ? { assigneeIds: [assignee] } : {}),
      }),
    (result, input) => {
      if (input.dryRun) {
        setPreview(result);
        return;
      }
      announce(t("announceMoved"));
      onClose();
    },
    { refresh: (_result, input) => !input.dryRun },
  );
  const who = (ids: readonly (string | null)[]) =>
    ids.length === 0 ? t("unassigned") : ids.map((id) => texts.member(id)).join(", ");
  const newAssignees = assignee === KEEP ? item.assigneeIds : [assignee];
  const impact = preview?.impact ?? null;
  const effects: string[] = [];
  if (impact) {
    effects.push(impact.overdue ? t("moveBecomesOverdue") : t("moveNotOverdue"));
    if (impact.remindersMoved)
      effects.push(t("moveRemindersMoved", { count: impact.remindersMoved }));
    if (impact.remindersEnded)
      effects.push(t("moveRemindersEnded", { count: impact.remindersEnded }));
    if (impact.handoverEnded) effects.push(t("moveHandoverEnded"));
    if (impact.volunteerEnded) effects.push(t("moveVolunteerEnded"));
    if (impact.releaseNow) effects.push(t("moveReleaseNow"));
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("moveTitle", { title: item.title })}
      description={t("moveBody")}
      closeLabel={t("close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          {preview ? (
            <Button
              loading={mutation.busy}
              onClick={() => {
                mutation.mutate({ dryRun: false });
              }}
              data-testid="chore-move-confirm"
            >
              {t("moveConfirm")}
            </Button>
          ) : (
            <Button
              loading={mutation.busy}
              onClick={() => {
                if (date === item.date && assignee === KEEP) {
                  setNothing(true);
                  return;
                }
                mutation.mutate({ dryRun: true });
              }}
              data-testid="chore-move-preview"
            >
              {t("movePreview")}
            </Button>
          )}
        </>
      }
    >
      {region}
      <div className="flex flex-col gap-4" data-testid="chore-move">
        <fieldset className="flex flex-col gap-3" disabled={preview !== null}>
          <legend className="sr-only">{t("moveTitle", { title: item.title })}</legend>
          <TextField
            type="date"
            label={t("fieldDueDate")}
            value={date}
            required
            onChange={(event) => {
              setNothing(false);
              if (event.target.value) setDate(event.target.value);
            }}
            className="max-w-60"
            data-testid="chore-move-date"
          />
          <SelectField
            label={t("moveAssignee")}
            value={assignee}
            options={[
              { value: KEEP, label: t("moveKeepAssignee", { people: who(item.assigneeIds) }) },
              ...members.map((member) => ({ value: member.id, label: texts.member(member.id) })),
            ]}
            onChange={(event) => {
              setNothing(false);
              setAssignee(event.target.value);
            }}
            data-testid="chore-move-assignee"
          />
        </fieldset>
        {nothing ? (
          <FormAlert tone="info" announce>
            {t("moveNothing")}
          </FormAlert>
        ) : null}
        {preview ? (
          <div className="flex flex-col gap-1" role="status" data-testid="chore-move-summary">
            <p className="text-body text-fg">
              {t("moveFromTo", {
                from: formatTaskDate(item.date, formats),
                to: formatTaskDate(date, formats),
              })}
            </p>
            <p className="text-body text-fg">
              {t("moveWhoFromTo", { from: who(item.assigneeIds), to: who(newAssignees) })}
            </p>
            {effects.map((effect) => (
              <p key={effect} className="text-body text-fg-muted">
                {effect}
              </p>
            ))}
            <p className="text-helper text-fg-muted">{t("moveOnlyThis")}</p>
          </div>
        ) : null}
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure, mutation.error.detail)}
          </FormAlert>
        ) : null}
      </div>
    </Dialog>
  );
}
