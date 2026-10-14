import { useTranslations } from "next-intl";

import type { InvitationKind, InvitationRole } from "@/invitations/schema";
import type { InvitationState, RequestState } from "@/invitations/types";

/** Translated names for invitation kinds, roles and states. Works in server and client components. */
export function useInvitationLabels() {
  const t = useTranslations("Invitations");
  const tHomes = useTranslations("Homes");
  const roles: { readonly [R in InvitationRole]: string } = {
    member: tHomes("roleMember"),
    administrator: tHomes("roleAdministrator"),
  };
  const kinds: { readonly [K in InvitationKind]: string } = {
    email: t("kindEmail"),
    link: t("kindLink"),
    join_code: t("kindJoinCode"),
  };
  const invitationStates: { readonly [S in InvitationState]: string } = {
    active: t("stateActive"),
    expired: t("stateExpired"),
    revoked: t("stateRevoked"),
    declined: t("stateDeclined"),
    accepted: t("stateAccepted"),
    used_up: t("stateUsedUp"),
    invalid: t("stateInvalid"),
  };
  const requestStates: { readonly [S in RequestState]: string } = {
    pending: t("requestPending"),
    approved: t("requestApproved"),
    declined: t("requestDeclined"),
    withdrawn: t("requestWithdrawn"),
    expired: t("requestExpired"),
  };
  return {
    kind: (kind: InvitationKind) => kinds[kind],
    role: (role: InvitationRole) => roles[role],
    invitationState: (state: InvitationState) => invitationStates[state],
    requestState: (state: RequestState) => requestStates[state],
  };
}
