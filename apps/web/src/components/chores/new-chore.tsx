"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORES_ENDPOINT,
  sendChoreRequest,
  type ChoreTemplate,
  type CreateChoreResponse,
} from "@/chores/api";
import { choresPath } from "@/chores/format";
import type { CreateChoreInput } from "@/chores/schema";
import type { DateFormat } from "@/preferences/schema";
import { memberNames, type MemberOption } from "@/tasks/format";

import { ChoreForm, emptyChore, type ChoreFormInput, type ChoreFormOutput } from "./chore-form";
import { templateDraft } from "./template-manager";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface NewChoreProps {
  readonly homeId: string;
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly members: readonly MemberOption[];
  /** The Home's today, the first date offered. */
  readonly today: string;
  readonly dateFormat: DateFormat;
  /** The Home's active templates to start from (chore managers). */
  readonly templates?: readonly ChoreTemplate[];
}

/**
 * Adding a chore (S20, chore managers). Each opening of the form gets a fresh id, so a retry after
 * a lost answer finds the chore already there instead of creating a second one. After creating,
 * the person can open its first occurrence. Starting from a template copies its title,
 * instructions, category (when still offered), estimate and checklist into the form, where all of
 * it can be changed; assignment, schedule and approval are always chosen here (spec "Confirmed
 * reusable chore templates"). The chore is an independent copy.
 */
export function NewChore({
  homeId,
  categories,
  members,
  today,
  dateFormat,
  templates = [],
}: NewChoreProps) {
  const t = useTranslations("Chores");
  const router = useRouter();
  const texts = useChoreTexts(memberNames(members));
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [formKey, setFormKey] = useState(0);
  const [created, setCreated] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [defaults, setDefaults] = useState<ChoreFormInput>(() => emptyChore(today));
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const mutation = useChoreMutation(
    `chore-create:${draftId}`,
    (input: CreateChoreInput) =>
      sendChoreRequest<CreateChoreResponse>("POST", CHORES_ENDPOINT, input),
    (result) => {
      announce(t("announceCreated"));
      setCreated(result.occurrenceId);
      setDraftId(crypto.randomUUID());
      setFormKey((key) => key + 1);
      setTemplateId("");
      setDefaults(emptyChore(today));
      setOpen(false);
      requestAnimationFrame(() => opener.current?.focus());
    },
  );

  function submit(values: ChoreFormOutput) {
    mutation.mutate({ id: draftId, homeId, ...values });
  }

  return (
    <section aria-labelledby="new-chore-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="new-chore-heading" className="sr-only">
          {t("newChoreHeading")}
        </h2>
        {!open ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              ref={opener}
              onClick={() => {
                setOpen(true);
                setCreated(null);
              }}
              data-testid="new-chore-open"
            >
              {t("newChore")}
            </Button>
            {created ? (
              <Button
                variant="ghost"
                onClick={() => {
                  router.push(`${choresPath(homeId)}/${created}`);
                }}
                data-testid="new-chore-view"
              >
                {t("openCreated")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
            {templates.length > 0 ? (
              <div className="flex flex-wrap items-end gap-3">
                <SelectField
                  label={t("fromTemplate")}
                  description={t("fromTemplateHelp")}
                  value={templateId}
                  options={[
                    { value: "", label: t("noTemplate") },
                    ...templates.map((template) => ({ value: template.id, label: template.title })),
                  ]}
                  onChange={(event) => {
                    setTemplateId(event.target.value);
                  }}
                  className="max-w-md"
                  data-testid="new-chore-template"
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    // Copying replaces what the form holds and starts it again at the title.
                    const chosen = templates.find((template) => template.id === templateId);
                    setDefaults(
                      chosen
                        ? {
                            ...emptyChore(today),
                            ...templateDraft(chosen, (id) =>
                              categories.some((category) => category.id === id),
                            ),
                          }
                        : emptyChore(today),
                    );
                    setFormKey((key) => key + 1);
                    announce(chosen ? t("announceTemplateCopied") : t("announceFormCleared"));
                  }}
                  data-testid="new-chore-template-apply"
                >
                  {templateId === "" ? t("clearForm") : t("useTemplate")}
                </Button>
              </div>
            ) : null}
            <ChoreForm
              key={formKey}
              defaults={defaults}
              categories={categories}
              members={members}
              today={today}
              busy={mutation.busy}
              onSubmit={submit}
              onCancel={() => {
                setOpen(false);
                mutation.reset();
                requestAnimationFrame(() => opener.current?.focus());
              }}
              submitLabel={t("addChore")}
              dateFormat={dateFormat}
            />
            {mutation.error ? (
              <FormAlert tone="error" announce>
                {texts.failure(mutation.error.failure, mutation.error.detail)}
              </FormAlert>
            ) : null}
          </div>
        )}
      </HydrationGate>
    </section>
  );
}
