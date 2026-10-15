import "server-only";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { FormAlert } from "@/components/auth/form-alert";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getRecoveredHomes } from "@/recovery/server";

const NOTICE_DAYS = 30;

/**
 * On the personal dashboard of a former Owner (S12b): a Home recently taken over through a
 * verified recovery, with the way to appeal. Shown for 30 days, or until they appeal; the
 * appeal page keeps the full list.
 */
export async function RecoveredHomesNotice({ now }: { readonly now: Date }) {
  const recovered = await getRecoveredHomes();
  if (recovered.status !== "ok") return null;
  const cutoff = now.getTime() - NOTICE_DAYS * 24 * 60 * 60 * 1000;
  const recent = recovered.homes.filter(
    (home) => home.appealStatus === null && new Date(home.completedAt).getTime() >= cutoff,
  );
  if (recent.length === 0) return null;
  const [t, formats] = await Promise.all([getTranslations("Recovery"), getDateTimeFormats()]);
  return (
    <FormAlert tone="info" className="mb-6">
      <ul className="flex flex-col gap-1" data-testid="recovered-homes-notice">
        {recent.map((home) => (
          <li key={home.recoveryId}>
            {t("recoveredNotice", {
              home: home.homeName,
              date: formatDateTime(home.completedAt, formats),
            })}
          </li>
        ))}
      </ul>
      <p className="mt-1">
        <Link href="/settings/recoveries" className="font-medium text-accent-fg underline">
          {t("recoveredLink")}
        </Link>
      </p>
    </FormAlert>
  );
}
