import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { listMyDeactivationBlockers } from "@/activity/server";
import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { CancelPendingCopies } from "@/components/copies/cancel-pending-copies";
import { DeleteAccount } from "@/components/deletion/delete-account";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { CopyToHomeLink } from "@/components/copies/copy-origin";
import { copyPagePath } from "@/copies/catalogue";
import { listMyOpenHomeCopies, listMySharedCopyableItems } from "@/copies/server";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Deletion");
  return { title: await pageTitle(t("accountTitle")) };
}

interface DeleteAccountPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Settings › Privacy › Delete account (S40). Explains what is deleted, what stays and the 30-day
 * recovery period, offers an export first, lists any Home that first needs another Owner, then asks
 * for the confirmation word and a fresh "confirm it's you".
 */
export default async function DeleteAccountPage({ searchParams }: DeleteAccountPageProps) {
  await requireIdentity();
  const [t, tCopies, params, user, security, blockers, openCopies, shared, formats] =
    await Promise.all([
      getTranslations("Deletion"),
      getTranslations("HomeCopies"),
      searchParams,
      getVerifiedUser(),
      getAccountSecurity(),
      listMyDeactivationBlockers(),
      listMyOpenHomeCopies(),
      listMySharedCopyableItems(),
      getDateTimeFormats(),
    ]);
  if (!user) return null;
  const hasPassword = security.status === "ok" ? security.value.hasPassword : true;

  return (
    <>
      <PageHeader title={t("accountTitle")} />
      <p className="mb-4">
        <Link href="/settings/privacy" className="text-body font-medium text-accent-fg underline">
          {t("backToPrivacy")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("accountWhatTitle")}>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-body">
            <li>{t("accountWhatRecovery")}</li>
            <li>{t("accountWhatSuspended")}</li>
            <li>{t("accountWhatDeleted")}</li>
            <li>{t("accountWhatHomes")}</li>
            <li>{t("accountWhatHistory")}</li>
            <li>{t("accountWhatPrivate")}</li>
            <li>{t("accountWhatGoogle")}</li>
          </ul>
        </Card>
        <Card title={t("accountExportTitle")}>
          <p className="text-body">
            {t("accountExportText")}{" "}
            <Link href="/settings/privacy/export" className="font-medium text-accent-fg underline">
              {t("accountExportLink")}
            </Link>
          </p>
        </Card>
        {/* S40 part 2: optionally keep items shared with a Home as that Home's own copy, item by
            item; account deletion stays possible without it. */}
        {shared.status === "ok" && shared.value.length > 0 ? (
          <Card title={tCopies("sharedTitle")}>
            <p className="mb-3 text-body">{tCopies("sharedIntro")}</p>
            <ul className="flex flex-col gap-3" data-testid="account-deletion-shared">
              {shared.value.map((item) => (
                <li key={`${item.itemType}:${item.itemId}`} className="flex flex-col gap-1">
                  <p className="text-body">
                    <span className="font-semibold">
                      {item.label ?? tCopies(`untitled.${item.itemType}`)}
                    </span>{" "}
                    <span className="text-fg-muted">({tCopies(`type.${item.itemType}`)})</span>
                  </p>
                  <p className="text-helper text-fg-muted">
                    {tCopies("sharedIn", { homes: item.homes.join(", ") })}
                  </p>
                  <CopyToHomeLink href={copyPagePath(item.itemType, item.itemId)} />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {/* S40 part 2: open copy requests to Homes must be cancelled (or finish) first. */}
        {openCopies.status === "ok" && openCopies.value.length > 0 ? (
          <Card title={tCopies("pendingTitle")}>
            <CancelPendingCopies
              rows={openCopies.value.map((row) => ({
                id: row.id,
                homeName: row.homeName,
                itemType: row.itemType,
                label: row.label,
                status: row.status,
                expires: formatDateTime(row.expiresAt, formats),
              }))}
            />
          </Card>
        ) : null}
        <Card title={t("accountConfirmTitle")}>
          {blockers.status === "ok" ? (
            <DeleteAccount
              email={user.email ?? ""}
              userId={user.id}
              twoFactor={verifiedTotpFactor(user) !== null}
              hasPassword={hasPassword}
              confirmed={parseAccountChangeAction(params.confirmed)}
              blockers={blockers.value}
            />
          ) : (
            <FormAlert tone="error">{t("unavailable")}</FormAlert>
          )}
        </Card>
      </div>
    </>
  );
}
