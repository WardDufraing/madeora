"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
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
import { VACATIONS_ENDPOINT, type VacationMutationResult } from "@/vacations/api";

import { ImpactPreview } from "./impact-preview";
import { stayRowSchema, useVacationFieldMessage } from "./stay-fields";

const formSchema = z
  .object({
    name: z.string().max(VACATION_LIMITS.name * 2, "tooLong"),
    people: z.array(stayRowSchema).min(1).max(VACATION_LIMITS.people),
    reminderDays: z.union([
      z.literal(""),
      z.coerce
        .number()
        .int()
        .min(1, "reminderRange")
        .max(VACATION_LIMITS.reminderDays, "reminderRange"),
    ]),
  })
  .refine(
    (form) => new Set(form.people.map((person) => person.memberId)).size === form.people.length,
    { message: "duplicateMember", path: ["people"] },
  );
type FormInput = z.input<typeof formSchema>;
type FormParsed = z.output<typeof formSchema>;

interface Body {
  readonly name: string;
  readonly people: readonly { memberId: string; startsOn: string; endsOn: string }[];
  readonly reminderDays: number | null;
}

/** The form path of one person's field; React Hook Form types array paths with a number index. */
function personField<K extends "memberId" | "startsOn" | "endsOn">(
  index: number,
  key: K,
): `people.${number}.${K}` {
  return `people.${index.toFixed(0)}.${key}` as `people.${number}.${K}`;
}

/**
 * Recording a vacation (S22; spec "member-scoped vacations and participant approval"). A chore
 * manager picks any members, each with their own dates, and may ask for a reminder; any other member
 * is in it themselves and may suggest others, who are invited and accept or decline. The preview
 * shows what changes for chores before anything is saved. Each opening gets a fresh id, so a retry
 * after a lost answer finds the vacation already there.
 */
export function NewVacation({
  homeId,
  members,
  today,
  canManage,
  formats,
}: {
  readonly homeId: string;
  readonly members: readonly MemberOption[];
  readonly today: string;
  readonly canManage: boolean;
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
}) {
  const t = useTranslations("Vacations");
  const names = memberNames(members);
  const texts = useChoreTexts(names);
  const message = useVacationFieldMessage();
  const self = members.find((member) => member.isSelf);
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<{ body: Body; result: VacationMutationResult } | null>(
    null,
  );
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const defaults = (): FormInput => ({
    name: "",
    people: [{ memberId: self?.id ?? "", startsOn: addDays(today, 1), endsOn: addDays(today, 7) }],
    reminderDays: "",
  });
  const form = useForm<FormInput, unknown, FormParsed>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(),
  });
  const people = useFieldArray({ control: form.control, name: "people" });
  const mutation = useChoreMutation(
    `vacation-create:${draftId}`,
    ({ body, dryRun }: { body: Body; dryRun: boolean }) =>
      sendChoreRequest<VacationMutationResult>("POST", VACATIONS_ENDPOINT, {
        id: draftId,
        homeId,
        ...body,
        dryRun,
      }),
    (result, { body, dryRun }) => {
      if (dryRun) {
        setPreview({ body, result });
        return;
      }
      announce(t("announceCreated"));
      setPreview(null);
      setDraftId(crypto.randomUUID());
      form.reset(defaults());
      setOpen(false);
      requestAnimationFrame(() => opener.current?.focus());
    },
    { refresh: (_result, { dryRun }) => !dryRun },
  );
  const close = () => {
    setOpen(false);
    setPreview(null);
    mutation.reset();
    requestAnimationFrame(() => opener.current?.focus());
  };
  const errors = form.formState.errors;
  const memberOptions = members.map((member) => ({
    value: member.id,
    label: member.isSelf ? t("you") : texts.member(member.id),
  }));

  return (
    <section aria-labelledby="new-vacation-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="new-vacation-heading" className="text-section-title font-semibold text-fg">
          {t("newHeading")}
        </h2>
        {!open ? (
          <div>
            <Button
              ref={opener}
              onClick={() => {
                setOpen(true);
              }}
              data-testid="vacation-new-open"
            >
              {t("newVacation")}
            </Button>
          </div>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
            data-testid="vacation-new-form"
            onChange={() => {
              setPreview(null);
            }}
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                const body: Body = {
                  name: values.name,
                  people: values.people,
                  reminderDays: values.reminderDays === "" ? null : values.reminderDays,
                };
                mutation.mutate({ body, dryRun: true });
              })(event);
            }}
          >
            <p className="text-body text-fg-muted">
              {canManage ? t("newIntroManager") : t("newIntro")}
            </p>
            <TextField
              label={t("fieldName")}
              description={t("fieldNameHelp")}
              autoComplete="off"
              maxLength={VACATION_LIMITS.name * 2}
              error={message(errors.name)}
              {...form.register("name")}
            />
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-body font-medium text-fg">{t("fieldPeople")}</legend>
              {people.fields.map((field, index) => {
                const own = !canManage && index === 0;
                return (
                  <div
                    key={field.id}
                    className="grid gap-3 rounded-card border border-line p-3 sm:grid-cols-3"
                    data-testid="vacation-person-row"
                  >
                    {own ? (
                      <p className="text-body text-fg sm:col-span-3">{t("youTakePart")}</p>
                    ) : (
                      <SelectField
                        label={t("fieldMember")}
                        options={[{ value: "", label: t("pickMember") }, ...memberOptions]}
                        {...form.register(personField(index, "memberId"))}
                      />
                    )}
                    <TextField
                      type="date"
                      label={t("fieldStartsOn")}
                      min={canManage || own ? today : addDays(today, 1)}
                      error={message(
                        errors.people?.[index]?.startsOn ?? errors.people?.[index]?.memberId,
                      )}
                      {...form.register(personField(index, "startsOn"))}
                    />
                    <TextField
                      type="date"
                      label={t("fieldEndsOn")}
                      min={today}
                      error={message(errors.people?.[index]?.endsOn)}
                      {...form.register(personField(index, "endsOn"))}
                    />
                    {own ? null : (
                      <div className="flex items-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            people.remove(index);
                            setPreview(null);
                          }}
                        >
                          {t("removeRow")}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {errors.people?.root?.message || errors.people?.message ? (
                <p className="text-helper text-danger" role="alert">
                  {message(errors.people.root ?? errors.people)}
                </p>
              ) : null}
              {people.fields.length < Math.min(VACATION_LIMITS.people, members.length) ? (
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const [first] = form.getValues("people");
                      people.append({
                        memberId: "",
                        startsOn: first?.startsOn ?? addDays(today, 1),
                        endsOn: first?.endsOn ?? addDays(today, 7),
                      });
                      setPreview(null);
                    }}
                    data-testid="vacation-add-row"
                  >
                    {canManage ? t("addPerson") : t("suggestPerson")}
                  </Button>
                </div>
              ) : null}
              {!canManage && people.fields.length > 1 ? (
                <p className="text-helper text-fg-muted">{t("suggestHelp")}</p>
              ) : null}
            </fieldset>
            {canManage ? (
              <TextField
                type="number"
                inputMode="numeric"
                min={1}
                max={VACATION_LIMITS.reminderDays}
                label={t("fieldReminder")}
                description={t("fieldReminderHelp")}
                error={message(errors.reminderDays)}
                className="max-w-60"
                {...form.register("reminderDays")}
              />
            ) : null}
            {preview?.result.impact ? (
              <ImpactPreview impact={preview.result.impact} names={names} formats={formats} />
            ) : null}
            {mutation.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(mutation.error.failure, mutation.error.detail)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {preview ? (
                <Button
                  loading={mutation.busy}
                  onClick={() => {
                    mutation.mutate({ body: preview.body, dryRun: false });
                  }}
                  data-testid="vacation-new-confirm"
                >
                  {t("confirmCreate")}
                </Button>
              ) : (
                <Button type="submit" loading={mutation.busy} data-testid="vacation-new-preview">
                  {t("preview")}
                </Button>
              )}
              <Button variant="secondary" onClick={close} disabled={mutation.busy}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
      </HydrationGate>
    </section>
  );
}
