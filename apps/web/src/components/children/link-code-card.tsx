"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { cancelChildLinkCode, issueChildLinkCode } from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";

/**
 * Link this child to another Home (S41): the primary guardian creates a one-time code and gives it
 * to an adult in the other Home, who enters it there and becomes the child's primary guardian in
 * that Home. The code is shown only now; a new code replaces the open one.
 */
export function LinkCodeCard({
  homeId,
  membershipId,
  childName,
  openUntil,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly childName: string;
  /** When the open code expires, already formatted, or null when there is none. */
  readonly openUntil: string | null;
}) {
  const t = useTranslations("Children");
  const router = useRouter();
  const hydrated = useHydrated();
  const [code, setCode] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);
  const issue = useMutation<{ readonly code: string }, MemberActionError>({
    mutationFn: () => issueChildLinkCode(homeId, membershipId),
    onSuccess: (result) => {
      setWithdrawn(false);
      setCode(result.code);
      router.refresh();
    },
  });
  const cancel = useMutation<undefined, MemberActionError>({
    mutationFn: async () => {
      await cancelChildLinkCode(homeId, membershipId);
      return undefined;
    },
    onSuccess: () => {
      setCode(null);
      setWithdrawn(true);
      router.refresh();
    },
  });
  const pending = issue.isPending || cancel.isPending;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-fg-muted">{t("linkHint", { name: childName })}</p>
      {code !== null ? (
        <div className="flex flex-col gap-1" role="status">
          <p className="text-body text-fg">{t("linkCodeShown")}</p>
          <p
            className="font-mono text-body font-semibold tracking-wider text-fg"
            data-testid="link-code"
            translate="no"
          >
            {code}
          </p>
        </div>
      ) : openUntil !== null && !withdrawn ? (
        <p className="text-body text-fg">{t("linkCodeOpen", { date: openUntil })}</p>
      ) : null}
      <MemberFailureAlert failure={issue.error?.failure ?? cancel.error?.failure ?? null} />
      {withdrawn ? (
        <FormAlert tone="success" announce>
          {t("linkCodeWithdrawn")}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={!hydrated || pending}
          loading={issue.isPending}
          onClick={() => {
            issue.mutate();
          }}
        >
          {code !== null || openUntil !== null ? t("linkCodeNew") : t("linkCodeCreate")}
        </Button>
        {(code !== null || openUntil !== null) && !withdrawn ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!hydrated || pending}
            loading={cancel.isPending}
            onClick={() => {
              cancel.mutate();
            }}
          >
            {t("linkCodeWithdraw")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
