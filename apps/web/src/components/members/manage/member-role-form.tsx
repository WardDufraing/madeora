"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { useRoleLabel } from "@/components/shell/use-role-label";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  changeMemberRole,
  type MemberActionError,
  type RoleChangeResponse,
} from "@/members/manage-api";
import { assignableRoles, type AssignableRole } from "@/members/manage-schema";

import { MemberFailureAlert } from "./member-failure-alert";

/**
 * The Owner's choice between Member and Administrator for another member (S12). Saving asks first,
 * explaining what changes; the request carries the role the Owner saw, so a change made meanwhile
 * by anyone else is refused instead of overwritten.
 */
export function MemberRoleForm({
  homeId,
  homeName,
  membershipId,
  memberName,
  currentRole,
}: {
  readonly homeId: string;
  readonly homeName: string;
  readonly membershipId: string;
  readonly memberName: string;
  readonly currentRole: AssignableRole;
}) {
  const t = useTranslations("Manage");
  const roleLabel = useRoleLabel();
  const router = useRouter();
  const hydrated = useHydrated();
  const idPrefix = useId();
  const [choice, setChoice] = useState<AssignableRole>(currentRole);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation<RoleChangeResponse, MemberActionError, AssignableRole>({
    mutationFn: (role) =>
      changeMemberRole(homeId, membershipId, { role, expectedRole: currentRole }),
    onSuccess: ({ role }) => {
      setConfirming(false);
      setNotice(t("roleChanged", { name: memberName, role: roleLabel(role) }));
      router.refresh();
    },
    onError: () => {
      setConfirming(false);
      router.refresh();
    },
  });

  const descriptions: { readonly [R in AssignableRole]: string } = {
    member: t("roleMemberDescription"),
    administrator: t("roleAdministratorDescription"),
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice === currentRole || mutation.isPending) return;
        setNotice(null);
        mutation.reset();
        setConfirming(true);
      }}
    >
      {notice ? (
        <FormAlert tone="success" announce>
          {notice}
        </FormAlert>
      ) : null}
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-body font-medium text-fg">{t("roleLegend")}</legend>
        {assignableRoles.map((role) => (
          <div key={role} className="flex items-start gap-3">
            <input
              id={`${idPrefix}-${role}`}
              type="radio"
              name="role"
              value={role}
              checked={choice === role}
              onChange={() => {
                setChoice(role);
              }}
              aria-describedby={`${idPrefix}-${role}-description`}
              className="mt-0.5 size-5 shrink-0 cursor-pointer accent-accent"
            />
            <div className="flex flex-col">
              <label htmlFor={`${idPrefix}-${role}`} className="cursor-pointer text-body text-fg">
                {roleLabel(role)}
              </label>
              <span id={`${idPrefix}-${role}-description`} className="text-helper text-fg-muted">
                {descriptions[role]}
              </span>
            </div>
          </div>
        ))}
      </fieldset>
      <div>
        <Button type="submit" disabled={!hydrated || choice === currentRole}>
          {t("saveRole")}
        </Button>
      </div>

      <Dialog
        open={confirming}
        onClose={() => {
          if (!mutation.isPending) setConfirming(false);
        }}
        closeLabel={t("close")}
        title={t("roleConfirmTitle", { name: memberName })}
        description={
          choice === "administrator"
            ? t("promoteDescription", { name: memberName, home: homeName })
            : t("demoteDescription", { name: memberName, home: homeName })
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant={choice === "member" ? "destructive" : "primary"}
              loading={mutation.isPending}
              onClick={() => {
                if (!mutation.isPending) mutation.mutate(choice);
              }}
            >
              {t("roleConfirm")}
            </Button>
          </>
        }
      />
    </form>
  );
}
