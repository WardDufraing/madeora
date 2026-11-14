"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { forgetMemory } from "@/ora/memories/client";
import type { OraMemory } from "@/ora/memories/types";

export interface OraMemoriesProps {
  readonly memories: readonly OraMemory[];
  /** The person's Homes, to name where a memory applies. */
  readonly homes: readonly { readonly id: string; readonly name: string }[];
  /** The memories could not be read; say so rather than show an empty list. */
  readonly unavailable?: boolean;
}

/**
 * What Ora remembers (S47b; spec "controlled long-term Ora memory"): each remembered list choice,
 * where it applies, and a button to forget it. Personal to the person; nothing here is shared with
 * a Home or carried to another place. Ora uses a memory only to preselect a list, never to act.
 */
export function OraMemories({ memories, homes, unavailable = false }: OraMemoriesProps) {
  const t = useTranslations("OraMemories");
  const router = useRouter();
  const [forgotten, setForgotten] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const forget = useMutation({
    mutationFn: forgetMemory,
    onSuccess: (_data, input) => {
      setForgotten((current) => [...current, `${input.homeId ?? "personal"}:${input.key}`]);
      setNotice(true);
      // The pressed button is gone with its row: keep focus on this card.
      heading.current?.focus();
      router.refresh();
    },
  });

  const shown = memories.filter(
    (memory) => !forgotten.includes(`${memory.homeId ?? "personal"}:${memory.key}`),
  );
  const homeName = (id: string | null) =>
    id === null ? t("personal") : (homes.find((home) => home.id === id)?.name ?? t("aHome"));

  return (
    <Card title={t("title")} description={t("hint")}>
      <div ref={heading} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        <div role="status" className="text-helper text-fg-muted">
          {notice ? t("forgotten") : null}
        </div>
        {unavailable ? (
          <FormAlert tone="error" announce>
            {t("unavailable")}
          </FormAlert>
        ) : shown.length === 0 ? (
          <p className="text-helper text-fg-muted">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((memory) => (
              <li
                key={`${memory.homeId ?? "personal"}:${memory.key}`}
                className="flex flex-wrap items-center gap-2 rounded-control border border-line p-3"
              >
                <span className="min-w-0 flex-1 text-body">
                  {t(`key.${memory.key}`, {
                    list: memory.listName,
                    place: homeName(memory.homeId),
                  })}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={forget.isPending}
                  aria-label={t("forgetLabel", {
                    list: memory.listName,
                    place: homeName(memory.homeId),
                  })}
                  onClick={() => {
                    forget.mutate({ homeId: memory.homeId, key: memory.key });
                  }}
                >
                  {t("forget")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {forget.isError ? (
          <FormAlert tone="error" announce>
            {t("forgetFailed")}
          </FormAlert>
        ) : null}
      </div>
    </Card>
  );
}
