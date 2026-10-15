"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { markNotificationsRead, type NotificationActionError } from "@/notifications/api";
import type { MarkReadInput } from "@/notifications/schema";

function useMarkRead() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  return useMutation<number, NotificationActionError, MarkReadInput>({
    mutationFn: markNotificationsRead,
    scope: { id: "notifications-read" },
    onSettled: () => {
      // The refreshed page shows the new state, the bell's count and, after a lost session, the
      // sign-in page.
      startTransition(() => {
        router.refresh();
      });
    },
  });
}

/** Marks one notification read. `text` names it for screen readers. */
export function MarkReadButton({
  id,
  text,
  rowId,
}: {
  readonly id: string;
  readonly text: string;
  /** The list row this button belongs to; it keeps focus when the button goes away. */
  readonly rowId: string;
}) {
  const t = useTranslations("Notifications");
  const hydrated = useHydrated();
  const mutation = useMarkRead();
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={!hydrated}
        loading={mutation.isPending}
        aria-label={t("markReadFor", { text })}
        onClick={() => {
          if (!mutation.isPending) {
            mutation.mutate(
              { ids: [id] },
              {
                // The button disappears with the refresh; move focus to the row first.
                onSuccess: () => document.getElementById(rowId)?.focus(),
              },
            );
          }
        }}
      >
        {t("markRead")}
      </Button>
      {mutation.isError ? (
        <p role="alert" className="text-helper text-danger">
          {t("markFailed")}
        </p>
      ) : null}
    </div>
  );
}

/** Marks everything read, announcing the result. */
export function MarkAllReadButton() {
  const t = useTranslations("Notifications");
  const hydrated = useHydrated();
  const mutation = useMarkRead();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hydrated}
          loading={mutation.isPending}
          onClick={() => {
            if (!mutation.isPending) mutation.mutate({ all: true });
          }}
        >
          {t("markAllRead")}
        </Button>
      </div>
      {mutation.isSuccess ? (
        <FormAlert tone="success" announce>
          {t("markedAll")}
        </FormAlert>
      ) : null}
      {mutation.isError ? (
        <FormAlert tone="error" announce>
          {t("markFailed")}
        </FormAlert>
      ) : null}
    </div>
  );
}
