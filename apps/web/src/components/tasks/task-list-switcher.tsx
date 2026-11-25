"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { CreateDialog } from "@/components/ui/create-dialog";
import { AdaptiveSwitcher } from "@/components/ui/adaptive-switcher";
import { TextField } from "@/components/ui/text-field";
import { sendTaskRequest, TASK_LISTS_ENDPOINT } from "@/tasks/api";
import { listNameSchema } from "@/tasks/schema";
import { viewHref } from "@/tasks/views";

import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";
import { noMembers } from "@/tasks/format";

/**
 * The Lists view's list switcher (redesign decision 54): chips while there are few lists, a
 * searchable picker beyond that or on a narrow screen, and **+ New list** in both. Only the
 * viewer's rights decide whether New list shows; the database checks again.
 */
export function TaskListSwitcher({
  homeId,
  lists,
  current,
  canCreate,
}: {
  readonly homeId: string | null;
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly current: string | null;
  readonly canCreate: boolean;
}) {
  const t = useTranslations("Tasks");
  const router = useRouter();
  const texts = useTaskTexts(noMembers);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const mutation = useTaskMutation(
    `task-list-create:${draftId}`,
    (input: { readonly id: string; readonly name: string }) =>
      sendTaskRequest("POST", TASK_LISTS_ENDPOINT, { id: input.id, homeId, name: input.name }),
    (_result, input) => {
      setCreating(false);
      setName("");
      setDraftId(crypto.randomUUID());
      router.push(viewHref(homeId, "lists", { list: input.id }), { scroll: false });
    },
  );

  function open() {
    mutation.reset();
    setNameError(null);
    setCreating(true);
  }

  return (
    <>
      <AdaptiveSwitcher
        label={t("listsNav")}
        items={lists.map((list) => ({ id: list.id, label: list.name }))}
        value={current ?? ""}
        onChange={(id) => {
          router.push(viewHref(homeId, "lists", { list: id }), { scroll: false });
        }}
        {...(canCreate ? { createLabel: t("newList"), onCreate: open } : {})}
        searchLabel={t("searchLists")}
        noResultsLabel={t("noListsFound")}
        pickerLabel={t("chooseList")}
      />
      <CreateDialog
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        title={t("newList")}
        closeLabel={t("close")}
        submitLabel={t("listCreate")}
        cancelLabel={t("cancel")}
        submitting={mutation.busy}
        onSubmit={() => {
          const parsed = listNameSchema.safeParse(name);
          if (!parsed.success) {
            setNameError(
              parsed.error.issues[0]?.message === "tooLong"
                ? t("fieldTooLong")
                : t("fieldRequired"),
            );
            return;
          }
          setNameError(null);
          mutation.mutate({ id: draftId, name: parsed.data });
        }}
      >
        <TextField
          label={t("listNew")}
          value={name}
          autoComplete="off"
          error={nameError ?? undefined}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure, mutation.error.detail)}
          </FormAlert>
        ) : null}
      </CreateDialog>
    </>
  );
}
