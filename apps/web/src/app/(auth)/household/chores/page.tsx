import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { currentDeviceHash } from "@/child-sign-in/device";
import { getDeviceChoreBoard } from "@/child-sign-in/device-chores";
import { FormAlert } from "@/components/auth/form-alert";
import { HouseholdChores } from "@/components/child-sign-in/household-chores";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { formatTaskDate } from "@/tasks/format";

import { AuthPageTitle } from "../../auth-page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("HouseholdChores");
  return { title: await pageTitle(t("title")) };
}

/**
 * The chore screen of an approved household device (S42 part 2): the Home's open chores up to
 * today and its members, so whoever did a chore can record it without signing in. Any other
 * browser is told this works only on approved household devices.
 */
export default async function HouseholdChoresPage() {
  const [t, formats] = await Promise.all([
    getTranslations("HouseholdChores"),
    getDateTimeFormats(),
  ]);
  const deviceHash = await currentDeviceHash();
  const board = deviceHash ? await getDeviceChoreBoard(deviceHash) : null;

  return (
    <>
      <AuthPageTitle title={t("title")} />
      {board === undefined ? (
        <FormAlert tone="info">{t("unavailable")}</FormAlert>
      ) : board === null ? (
        <p className="text-body text-fg" data-testid="household-chores-not-approved">
          {t("notApproved")}
        </p>
      ) : (
        <HouseholdChores
          requirePin={board.requirePin}
          members={board.members}
          chores={board.chores.map((chore) => ({
            occurrenceId: chore.occurrenceId,
            title: chore.title,
            dueLabel: formatTaskDate(chore.dueDate, formats),
            overdue: chore.overdue,
            assigneeIds: chore.assigneeIds,
            mandatoryOpen: chore.mandatoryOpen,
            requiresApproval: chore.requiresApproval,
          }))}
        />
      )}
      <p className="mt-6 text-body">
        <Link href="/household" className="font-medium text-accent-fg underline">
          {t("pinSignInLink")}
        </Link>
      </p>
    </>
  );
}
