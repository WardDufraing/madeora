"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { focusOnMount } from "@/components/ui/focus-on-mount";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextArea } from "@/components/ui/text-area";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import {
  sendTaskRequest,
  TASK_COMMENTS_ENDPOINT,
  TASKS_ENDPOINT,
  type CommentPage,
  type TaskComment,
} from "@/tasks/api";
import { memberNames, taskKeys, type MemberOption } from "@/tasks/format";
import { commentBodySchema, TASK_LIMITS } from "@/tasks/schema";

import { HydrationGate } from "./hydration-gate";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface TaskCommentsProps {
  readonly userId: string;
  readonly taskId: string;
  readonly initial: CommentPage;
  readonly loadedAt: string;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}

type CommentChange =
  | { readonly kind: "add"; readonly id: string; readonly body: string }
  | { readonly kind: "edit"; readonly comment: TaskComment; readonly body: string }
  | { readonly kind: "delete"; readonly comment: TaskComment };

/**
 * A task's comments (S18): plain text, oldest first, with author and time and an "edited" mark.
 * Every member who can see the task may comment; each person edits and deletes only their own.
 * A send that is retried after a lost answer reuses its id, so it is stored once.
 */
export function TaskComments({
  userId,
  taskId,
  initial,
  loadedAt,
  members,
  formats,
}: TaskCommentsProps) {
  const t = useTranslations("Tasks");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useTaskTexts(names);
  const [body, setBody] = useState("");
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ readonly id: string; readonly body: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState<TaskComment | null>(null);
  const addField = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { announce, region } = useAnnouncer();

  const pages = useInfiniteQuery({
    queryKey: taskKeys.comments(userId, taskId, loadedAt),
    initialPageParam: 0,
    initialData: { pages: [initial], pageParams: [0] },
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ pageParam }) =>
      sendTaskRequest<CommentPage>(
        "GET",
        `${TASKS_ENDPOINT}/${taskId}/comments?offset=${String(pageParam)}`,
      ),
    getNextPageParam: (_last, all) => {
      const loaded = all.reduce((sum, page) => sum + page.comments.length, 0);
      return loaded < (all[0]?.total ?? 0) ? loaded : undefined;
    },
  });
  const comments = pages.data.pages.flatMap((page) => page.comments);

  const mutation = useTaskMutation(
    `task:${taskId}:comments`,
    (change: CommentChange) => {
      switch (change.kind) {
        case "add":
          return sendTaskRequest("POST", `${TASKS_ENDPOINT}/${taskId}/comments`, {
            id: change.id,
            body: change.body,
          });
        case "edit":
          return sendTaskRequest("PATCH", `${TASK_COMMENTS_ENDPOINT}/${change.comment.id}`, {
            expectedRevision: change.comment.revision,
            body: change.body,
          });
        case "delete":
          return sendTaskRequest("DELETE", `${TASK_COMMENTS_ENDPOINT}/${change.comment.id}`, {});
      }
    },
    (_result, change) => {
      if (change.kind === "add") {
        setBody("");
        setDraftId(crypto.randomUUID());
        announce(t("announceCommentAdded"));
        addField.current?.focus();
      } else if (change.kind === "edit") {
        setEditing(null);
        announce(t("announceCommentSaved"));
        headingRef.current?.focus();
      } else {
        announce(t("announceCommentDeleted"));
        headingRef.current?.focus();
      }
    },
  );

  function send() {
    const parsed = commentBodySchema.safeParse(body);
    if (!parsed.success) {
      setBodyError(
        parsed.error.issues[0]?.message === "tooLong" ? t("fieldTooLong") : t("fieldRequired"),
      );
      return;
    }
    setBodyError(null);
    mutation.mutate({ kind: "add", id: draftId, body: parsed.data });
  }

  return (
    <section aria-labelledby="task-comments-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2
          id="task-comments-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-section-title font-semibold text-fg outline-none"
        >
          {t("commentsHeading")}
        </h2>
        {comments.length === 0 ? (
          <p className="text-body text-fg-muted">{t("commentsEmpty")}</p>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="task-comments">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-control border border-line bg-surface p-3"
                data-testid="task-comment"
              >
                <p className="flex flex-wrap gap-x-2 text-helper text-fg-muted">
                  <span className="font-semibold text-fg">
                    <bdi>{texts.person(comment.author)}</bdi>
                  </span>
                  <time dateTime={comment.createdAt}>
                    {formatDateTime(comment.createdAt, formats)}
                  </time>
                  {comment.editedAt ? (
                    <span>
                      {t("commentEdited", { date: formatDateTime(comment.editedAt, formats) })}
                    </span>
                  ) : null}
                </p>
                {editing?.id === comment.id ? (
                  <form
                    className="mt-2 flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const parsed = commentBodySchema.safeParse(editing.body);
                      if (parsed.success) {
                        mutation.mutate({ kind: "edit", comment, body: parsed.data });
                      } else {
                        announce(
                          parsed.error.issues[0]?.message === "tooLong"
                            ? t("fieldTooLong")
                            : t("fieldRequired"),
                        );
                      }
                    }}
                  >
                    <TextArea
                      label={t("commentEditLabel")}
                      value={editing.body}
                      rows={3}
                      ref={focusOnMount}
                      maxLength={TASK_LIMITS.comment * 2}
                      onChange={(event) => {
                        setEditing({ id: comment.id, body: event.target.value });
                      }}
                    />
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" loading={mutation.busy}>
                        {t("save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(null);
                          headingRef.current?.focus();
                        }}
                      >
                        {t("cancel")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap break-words text-body text-fg">
                    {comment.body}
                  </p>
                )}
                {comment.author.me && editing?.id !== comment.id ? (
                  <div className="mt-2 flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing({ id: comment.id, body: comment.body });
                      }}
                    >
                      {t("edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRemoving(comment);
                      }}
                    >
                      {t("delete")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {pages.hasNextPage ? (
          <div>
            <Button
              variant="secondary"
              loading={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              {t("showMoreComments")}
            </Button>
          </div>
        ) : null}
        <form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <TextArea
            ref={addField}
            label={t("commentAdd")}
            description={t("commentAddHelp")}
            value={body}
            rows={3}
            error={bodyError ?? undefined}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            data-testid="comment-new"
          />
          <div>
            <Button type="submit" variant="secondary" loading={mutation.busy}>
              {t("commentSend")}
            </Button>
          </div>
        </form>
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
        <Dialog
          open={removing !== null}
          onClose={() => {
            setRemoving(null);
          }}
          title={t("confirmDeleteCommentTitle")}
          description={t("confirmDeleteCommentBody")}
          closeLabel={t("close")}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setRemoving(null);
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const comment = removing;
                  setRemoving(null);
                  if (comment) mutation.mutate({ kind: "delete", comment });
                }}
              >
                {t("delete")}
              </Button>
            </>
          }
        />
      </HydrationGate>
    </section>
  );
}
