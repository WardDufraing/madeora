"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { VACATION_LIMITS } from "@madeora/domain/vacations";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendChoreRequest } from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import { addDays } from "@/tasks/calendar";
import { memberNames, type MemberOption } from "@/tasks/format";
import { dateOnlySchema } from "@/tasks/schema";
import { CHORE_ABSENCES_ENDPOINT, type AbsenceSummary } from "@/vacations/api";
import { absenceReasonSchema } from "@/vacations/schema";

import { ChangeDialog } from "./change-dialog";
import { useVacationFieldMessage } from "./stay-fields";

const formSchema = z
  .object({
    memberId: z.string().min(1, "memberRequired"),
    startsOn: z
      .union([z.literal(""), dateOnlySchema])
      .refine((value) => value !== "", "dateRequired"),
    endsOn: z
      .union([z.literal(""), dateOnlySchema])
      .refine((value) => value !== "", "dateRequired"),
    reason: absenceReasonSchema,
  })
  .refine((absence) => absence.endsOn >= absence.startsOn, {
    message: "endBeforeStart",
    path: ["endsOn"],
  });
type FormInput = z.input<typeof formSchema>;
type FormParsed = z.output<typeof formSchema>;

/**
 * Registering a temporary absence (S22; spec "temporary chore absence periods"): a member their own,
 * a chore manager anyone's, with an optional private reason. Nothing changes on its own: the
 * absence's review lists the chores to decide about. Each opening gets a fresh id.
 */
export function NewAbsence({
  homeId,
  members,
  today,
  canManage,
}: {
  readonly homeId: string;
  readonly members: readonly MemberOption[];
  readonly today: string;
  readonly canManage: boolean;
}) {
  const t = useTranslations("Vacations");
  const texts = useChoreTexts(memberNames(members));
  const message = useVacationFieldMessage();
  const self = members.find((member) => member.isSelf);
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const defaults = (): FormInput => ({
    memberId: self?.id ?? "",
    startsOn: addDays(today, 1),
    endsOn: addDays(today, 1),
    reason: "",
  });
  const form = useForm<FormInput, unknown, FormParsed>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(),
  });
  const mutation = useChoreMutation(
    `absence-create:${draftId}`,
    (values: FormParsed) =>
      sendChoreRequest("POST", CHORE_ABSENCES_ENDPOINT, {
        id: draftId,
        homeId,
        memberId: values.memberId,
        startsOn: values.startsOn,
        endsOn: values.endsOn,
        ...(values.reason ? { reason: values.reason } : {}),
      }),
    () => {
      announce(t("announceAbsenceCreated"));
      setDraftId(crypto.randomUUID());
      form.reset(defaults());
      setOpen(false);
      requestAnimationFrame(() => opener.current?.focus());
    },
  );
  const errors = form.formState.errors;
  return (
    <section aria-labelledby="new-absence-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="new-absence-heading" className="text-section-title font-semibold text-fg">
          {t("newAbsenceHeading")}
        </h2>
        {!open ? (
          <div>
            <Button
              ref={opener}
              onClick={() => {
                setOpen(true);
              }}
              data-testid="absence-new-open"
            >
              {t("newAbsence")}
            </Button>
          </div>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
            data-testid="absence-new-form"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                mutation.mutate(values);
              })(event);
            }}
          >
            <p className="text-body text-fg-muted">{t("absenceIntro")}</p>
            {canManage ? (
              <SelectField
                label={t("fieldMember")}
                options={members.map((member) => ({
                  value: member.id,
                  label: member.isSelf ? t("you") : texts.member(member.id),
                }))}
                {...form.register("memberId")}
              />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                type="date"
                label={t("fieldStartsOn")}
                min={today}
                error={message(errors.startsOn)}
                {...form.register("startsOn")}
              />
              <TextField
                type="date"
                label={t("fieldEndsOn")}
                min={today}
                error={message(errors.endsOn)}
                {...form.register("endsOn")}
              />
            </div>
            <TextField
              label={t("fieldReason")}
              description={t("fieldReasonHelp")}
              autoComplete="off"
              maxLength={VACATION_LIMITS.reason * 2}
              error={message(errors.reason)}
              {...form.register("reason")}
            />
            {mutation.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(mutation.error.failure, mutation.error.detail)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={mutation.busy} data-testid="absence-new-submit">
                {t("saveAbsence")}
              </Button>
              <Button
                variant="secondary"
                disabled={mutation.busy}
                onClick={() => {
                  setOpen(false);
                  mutation.reset();
                  requestAnimationFrame(() => opener.current?.focus());
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
      </HydrationGate>
    </section>
  );
}

/** Editing (dates, ending early, reason) or removing an absence (S22). */
export function AbsenceActions({
  homeId,
  absence,
  label,
  members,
  formats,
}: {
  readonly homeId: string;
  readonly absence: AbsenceSummary;
  readonly label: string;
  readonly members: readonly MemberOption[];
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
}) {
  const t = useTranslations("Vacations");
  const names = memberNames(members);
  const message = useVacationFieldMessage();
  const [startsOn, setStartsOn] = useState(absence.startsOn);
  const [endsOn, setEndsOn] = useState(absence.endsOn);
  const [reason, setReason] = useState(absence.reason ?? "");
  const [error, setError] = useState<string | undefined>();
  const common = {
    scope: `absence:${absence.id}`,
    url: `${CHORE_ABSENCES_ENDPOINT}/${absence.id}`,
    method: "PATCH" as const,
    names,
    formats,
    previewed: false,
    withDryRun: false,
  };
  const memberId = absence.member?.member ?? null;
  return (
    <HydrationGate>
      <div className="flex flex-wrap gap-2">
        {absence.status !== "ended" && memberId !== null ? (
          <ChangeDialog
            {...common}
            label={t("editAbsence")}
            ariaLabel={t("editAbsenceNamed", { name: label })}
            title={t("editAbsenceTitle")}
            description={t("editAbsenceBody")}
            confirmLabel={t("save")}
            announcement={t("announceAbsenceSaved")}
            onOpen={() => {
              setStartsOn(absence.startsOn);
              setEndsOn(absence.endsOn);
              setReason(absence.reason ?? "");
              setError(undefined);
            }}
            fields={
              <>
                <TextField
                  type="date"
                  label={t("fieldStartsOn")}
                  value={startsOn}
                  disabled={absence.status === "active"}
                  onChange={(event) => {
                    setStartsOn(event.target.value);
                  }}
                />
                <TextField
                  type="date"
                  label={t("fieldEndsOn")}
                  value={endsOn}
                  error={error}
                  onChange={(event) => {
                    setEndsOn(event.target.value);
                  }}
                />
                <TextField
                  label={t("fieldReason")}
                  description={t("fieldReasonHelp")}
                  value={reason}
                  maxLength={VACATION_LIMITS.reason * 2}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              </>
            }
            build={() => {
              const parsed = formSchema.safeParse({ memberId, startsOn, endsOn, reason });
              if (!parsed.success) {
                setError(message(parsed.error.issues[0]));
                return null;
              }
              setError(undefined);
              return {
                action: "save",
                expectedRevision: absence.revision,
                homeId,
                memberId,
                startsOn,
                endsOn,
                ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
              };
            }}
            testId="absence-edit"
          />
        ) : null}
        <ChangeDialog
          {...common}
          variant="destructive"
          label={t("removeAbsence")}
          ariaLabel={t("removeAbsenceNamed", { name: label })}
          title={t("removeAbsenceTitle")}
          description={t("removeAbsenceBody")}
          confirmLabel={t("removeAbsence")}
          announcement={t("announceAbsenceRemoved")}
          build={() => ({ action: "remove", expectedRevision: absence.revision })}
          testId="absence-remove"
        />
      </div>
    </HydrationGate>
  );
}
