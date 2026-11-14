"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { clearHistory, fetchHistory } from "@/ora/history/client";

/**
 * Ora's short recent history (S47b; spec "seven-day rolling interaction history"): the last few
 * changes made through Ora in this place, one line each, and "Clear recent interactions". It is not
 * a transcript: there are no threads or search, a line never repeats a change, and clearing removes
 * only these lines (never a task, item or remembered choice). The server hides lines older than
 * seven days and lines of a Home the person no longer belongs to.
 */
export function OraHistory({
  userId,
  homeId,
  active,
}: {
  readonly userId: string;
  readonly homeId: string | null;
  readonly active: boolean;
}) {
  const t = useTranslations("OraHistory");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [cleared, setCleared] = useState(false);
  const history = useQuery({
    queryKey: ["ora", "history", userId, homeId ?? "personal"],
    queryFn: () => fetchHistory(homeId),
    enabled: active,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const clear = useMutation({
    mutationFn: clearHistory,
    onSuccess: async () => {
      setCleared(true);
      await queryClient.invalidateQueries({ queryKey: ["ora", "history", userId] });
      // The pressed button is gone with the lines: keep focus inside Ora's surface.
      document.getElementById("ora-surface")?.focus();
    },
  });

  const entries = (history.data ?? []).slice(0, 5);
  if (entries.length === 0 && !cleared) return null;
  return (
    <section aria-labelledby="ora-history-title" className="flex flex-col gap-2">
      <h3 id="ora-history-title" className="text-helper font-semibold text-fg-muted">
        {t("title")}
      </h3>
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => (
            <li key={entry.id} className="text-helper">
              {t(`kind.${entry.kind}`, { name: entry.label })}{" "}
              <span className="text-fg-muted">
                {format.dateTime(new Date(entry.createdAt), {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div role="status" className="text-helper text-fg-muted">
        {cleared && entries.length === 0 ? t("cleared") : null}
      </div>
      {clear.isError ? (
        <p role="alert" className="text-helper text-danger">
          {t("clearFailed")}
        </p>
      ) : null}
      {entries.length > 0 ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            loading={clear.isPending}
            onClick={() => {
              setCleared(false);
              clear.mutate();
            }}
          >
            {t("clear")}
          </Button>
          <p className="mt-1 text-helper text-fg-muted">{t("note")}</p>
        </div>
      ) : null}
    </section>
  );
}
