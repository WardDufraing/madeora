import "server-only";

import { getTranslations } from "next-intl/server";

import type { ReviewStep, SettingScope } from "./catalogue";
import type { PrivacyOverview } from "./server";

/** One summarised setting, linked to the place where it is actually changed. */
export interface PrivacyItem {
  readonly id: string;
  readonly step: ReviewStep;
  readonly scope: SettingScope;
  readonly title: string;
  /** The current value in plain words; null when it could not be loaded. */
  readonly value: string | null;
  /** Who can see or change it. */
  readonly who: string;
  /** The authoritative setting; null for facts without a setting (accounts are not searchable). */
  readonly href: string | null;
}

/**
 * Builds the privacy dashboard's and the guided review's summaries from the authoritative sources
 * (S39, spec "Confirmed central privacy dashboard"). Read only: nothing here changes a setting.
 * Private values are masked (the backup address already arrives masked from the database); device
 * identifiers and other members never appear.
 */
export async function privacyItems(overview: PrivacyOverview): Promise<readonly PrivacyItem[]> {
  const t = await getTranslations("Privacy");
  const tHomes = await getTranslations("Homes");
  const roleLabel = (role: string): string =>
    role === "owner"
      ? tHomes("roleOwner")
      : role === "administrator"
        ? tHomes("roleAdministrator")
        : tHomes("roleMember");
  const items: PrivacyItem[] = [];
  const onlyYou = t("whoOnlyYou");

  items.push(
    {
      id: "profile",
      step: "profile",
      scope: "account",
      title: t("item.profile"),
      value: overview.displayName
        ? t(overview.hasAvatar ? "value.profileWithPicture" : "value.profile", {
            name: overview.displayName,
          })
        : t("value.profileUnnamed"),
      who: t("whoHomeMembers"),
      href: "/settings",
    },
    {
      id: "discoverability",
      step: "profile",
      scope: "account",
      title: t("item.discoverability"),
      value: t("value.notSearchable"),
      who: t("whoNobody"),
      href: null,
    },
  );

  if (overview.homes.status === "unavailable") {
    items.push({
      id: "homes",
      step: "homes",
      scope: "home",
      title: t("item.homes"),
      value: null,
      who: onlyYou,
      href: null,
    });
  } else if (overview.homes.value.length === 0) {
    items.push({
      id: "homes",
      step: "homes",
      scope: "home",
      title: t("item.homes"),
      value: t("value.noHomes"),
      who: onlyYou,
      href: null,
    });
  } else {
    for (const home of overview.homes.value) {
      const custom = [
        home.customName ? t("value.customName") : null,
        home.customAccent ? t("value.customAccent") : null,
        home.customAvatar ? t("value.customAvatar") : null,
      ].filter((part): part is string => part !== null);
      items.push({
        id: `home:${home.id}`,
        step: "homes",
        scope: "home",
        title: home.name,
        value: t("value.home", {
          role: roleLabel(home.role),
          presentation: custom.length > 0 ? custom.join(", ") : t("value.homeUsesAccount"),
        }),
        who: t("whoThisHome", { home: home.name }),
        href: `/homes/${encodeURIComponent(home.id)}/profile`,
      });
    }
  }

  items.push({
    id: "google",
    step: "connections",
    scope: "account",
    title: t("item.google"),
    value:
      overview.google.status === "ok"
        ? overview.google.value.connected
          ? t(
              overview.google.value.status === "connected"
                ? "value.googleConnected"
                : "value.googlePaused",
              { count: overview.google.value.sharedHomes },
            )
          : t("value.googleNone")
        : null,
    who: onlyYou,
    href: "/settings/google-calendar",
  });

  const security = overview.security.status === "ok" ? overview.security.value : null;
  items.push(
    {
      id: "sign-in",
      step: "security",
      scope: "account",
      title: t("item.signIn"),
      value: security
        ? t("value.signIn", {
            password: security.hasPassword ? "yes" : "no",
            twoFactor: security.twoFactor ? "on" : "off",
          })
        : null,
      who: onlyYou,
      href: "/settings/security#two-factor",
    },
    {
      id: "recovery",
      step: "security",
      scope: "account",
      title: t("item.recovery"),
      value: security
        ? security.backupEmail
          ? t("value.backupEmail", { email: security.backupEmail })
          : t("value.noBackupEmail")
        : null,
      who: onlyYou,
      href: "/settings/security#recovery",
    },
    {
      id: "alerts",
      step: "security",
      scope: "account",
      title: t("item.alerts"),
      value:
        overview.alerts.status === "ok"
          ? t("value.alerts", {
              newDevice: overview.alerts.value.newDevice ? "on" : "off",
              everySignIn: overview.alerts.value.everySignIn ? "on" : "off",
            })
          : null,
      who: onlyYou,
      href: "/settings/security/notifications",
    },
    {
      id: "sessions",
      step: "devices",
      scope: "device",
      title: t("item.sessions"),
      value:
        overview.sessions.status === "ok"
          ? t("value.sessions", { count: overview.sessions.value })
          : null,
      who: onlyYou,
      href: "/settings/security#sessions",
    },
    {
      id: "trusted",
      step: "devices",
      scope: "device",
      title: t("item.trusted"),
      value:
        overview.trustedDevices.status === "ok"
          ? t("value.trusted", { count: overview.trustedDevices.value })
          : null,
      who: onlyYou,
      href: "/settings/security#trusted",
    },
  );

  const latest = overview.exports.status === "ok" ? overview.exports.value[0] : undefined;
  items.push(
    {
      id: "export",
      step: "data_rights",
      scope: "account",
      title: t("item.export"),
      value:
        overview.exports.status === "ok"
          ? latest
            ? t("value.exportLatest", { status: t(`status.${latest.status}`).toLowerCase() })
            : t("value.exportNone")
          : null,
      who: onlyYou,
      href: "/settings/privacy/export",
    },
    {
      id: "activity",
      step: "data_rights",
      scope: "account",
      title: t("item.activity"),
      value: t("value.activity"),
      who: onlyYou,
      href: "/settings/activity",
    },
    {
      id: "deactivate",
      step: "data_rights",
      scope: "account",
      title: t("item.deactivate"),
      value: t("value.deactivate"),
      who: onlyYou,
      href: "/settings/security/deactivate",
    },
  );
  return items;
}
