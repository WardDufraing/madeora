import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { accentPalette, oraPaletteKeys } from "@madeora/design-tokens";
import { childCapabilities } from "@madeora/domain/permissions";
import { createTranslator } from "next-intl";

import {
  ACTIVITY_ACTORS,
  ACTIVITY_CATEGORIES,
  ACTIVITY_OUTCOMES,
  ALL_ACTIVITY_KINDS,
  ROLE_CODES,
  kindKey,
} from "@/activity/catalogue";
import { choreStateKey } from "@/chores/calendar";
import { stateKey } from "@/components/recovery/recovery-state-text";
import { staffStateKey } from "@/components/recovery/staff-state-label";
import { primaryNav, secondaryNav } from "@/components/shell/nav-items";
import { oraToolIds } from "@/ora/tools/ids";
import { connectNotices, googleScopes } from "@/google-calendar/schema";
import { changeActions, changeStates, googleFields, googleStates } from "@/google-calendar/shapes";
import {
  displayClockFormats,
  displayDensities,
  displayOrientations,
  displayThemes,
  displayWidgetSizes,
  displayWidgetTypes,
} from "@/displays/layout";
import { unitMessageKeys } from "@/habits/numeric-keys";
import {
  EXPORT_CATEGORIES,
  EXPORT_STATUSES,
  HOME_EXPORT_CATEGORIES,
  REVIEW_STEPS,
  DELETION_CATEGORIES,
  UNDELETABLE_CATEGORIES,
} from "@/privacy/catalogue";
import { COPY_END_CODES, COPY_ITEM_TYPES, COPY_OUTCOMES, COPY_STATUSES } from "@/copies/catalogue";

import { locales } from "./locales";
import en from "./messages/en.json";
import nl from "./messages/nl.json";

type Tree = { readonly [key: string]: string | Tree };
const dictionaries: Record<(typeof locales)[number], Tree> = { en, nl };

const withPrefix = (prefix: string, values: readonly string[]) =>
  values.map((value) => prefix + value);

/** Every message as `Namespace.key` → text. */
function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.set(path, value);
    else for (const [k, v] of flatten(value, path)) result.set(k, v);
  }
  return result;
}

/** ICU argument names used by a message, such as `section` in "{section} is …". */
function argumentsOf(message: string): string[] {
  return [...new Set([...message.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1] ?? ""))].sort();
}

const english = flatten(en);

/**
 * Message keys (`Namespace.key`) that no source file uses. A file uses `Namespace.key` when it
 * binds a translator to the namespace (`const t = useTranslations("Namespace")`, or
 * `getTranslations`, also inside `Promise.all([...])`) and calls it with the key as a string
 * literal. When a file calls a translator with a computed key, a string literal equal to a key of
 * that namespace in the same file also counts (for example a `{ light: "themeLight" }` lookup).
 * `dynamic` lists keys used through values from other files, such as navigation ids.
 */
export function unusedKeys(
  keys: readonly string[],
  sources: readonly string[],
  dynamic: Readonly<Record<string, readonly string[]>>,
): string[] {
  const used = new Set<string>();
  for (const [namespace, names] of Object.entries(dynamic)) {
    for (const name of names) used.add(`${namespace}.${name}`);
  }
  const call = String.raw`(?:useTranslations|getTranslations)\(\s*"(\w+)"\s*\)`;
  for (const source of sources) {
    const translators = new Map<string, string>();
    for (const [, name = "", namespace = ""] of source.matchAll(
      new RegExp(String.raw`const\s+(\w+)\s*=\s*(?:await\s+)?${call}`, "g"),
    )) {
      translators.set(name, namespace);
    }
    for (const [, names = "", items = ""] of source.matchAll(
      /const\s*\[([^\]]*)\]\s*=\s*await\s+Promise\.all\(\s*\[([\s\S]*?)\]\s*\)/g,
    )) {
      const bound = names.split(",").map((name) => name.trim());
      items.split(",").forEach((item, index) => {
        const match = new RegExp(call).exec(item);
        const name = bound[index];
        if (match?.[1] && name) translators.set(name, match[1]);
      });
    }
    const literals = new Set([...source.matchAll(/"([\w.]+)"/g)].map((match) => match[1] ?? ""));
    for (const [name, namespace] of translators) {
      for (const [, argument = ""] of source.matchAll(
        new RegExp(String.raw`\b${name}\(\s*([^,)]+)`, "g"),
      )) {
        const literal = /^"([\w.]+)"$/.exec(argument.trim());
        if (literal?.[1]) used.add(`${namespace}.${literal[1]}`);
        else for (const value of literals) used.add(`${namespace}.${value}`);
      }
    }
  }
  return keys.filter((key) => !used.has(key));
}

describe("message dictionaries", () => {
  it.each(locales)("%s has exactly the English keys, none empty", (locale) => {
    const messages = flatten(dictionaries[locale]);
    expect([...messages.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of messages) expect(text.trim(), key).not.toBe("");
  });

  it.each(locales)("%s uses the same ICU arguments as English in every message", (locale) => {
    for (const [key, text] of flatten(dictionaries[locale])) {
      expect(argumentsOf(text), key).toEqual(argumentsOf(english.get(key) ?? ""));
    }
  });

  it.each(locales)("%s messages all format without errors", (locale) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: dictionaries[locale],
      onError: (error) => errors.push(error.message),
    }) as unknown as (key: string, values?: Record<string, string>) => string;
    for (const [key, text] of flatten(dictionaries[locale])) {
      const values = Object.fromEntries(argumentsOf(text).map((name) => [name, "x"]));
      expect(typeof t(key, values)).toBe("string");
    }
    expect(errors).toEqual([]);
  });

  it("finds unused messages (the detector itself)", () => {
    const keys = ["A.used", "A.unused", "B.shared", "B.dynamic", "C.title"];
    const sources = [
      'const t = useTranslations("A");\nt("used");\nconst x = "unused-but-different";',
      'const [tB, tC] = await Promise.all([getTranslations("B"), getTranslations("Z")]);\ntB("shared"); tB(name);\nconst names = ["dynamic"];',
      'const title = "title";',
    ];
    expect(unusedKeys(keys, sources, {})).toEqual(["A.unused", "C.title"]);
    expect(unusedKeys(keys, sources, { C: ["title"] })).toEqual(["A.unused"]);
  });

  it("has no unused messages", () => {
    const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
      }
    };
    walk(sourceRoot);
    const sources = files.map((file) => readFileSync(file, "utf8"));
    // Navigation labels are looked up by item id (tNav(item.id)), so the ids are the keys.
    const dynamic = {
      Nav: [...primaryNav, ...secondaryNav].map((item) => item.id),
      // Ora (S45): tool labels by tool id, module group names, palette names, motion modes.
      Ora: [
        "suggestions.today-overview",
        ...withPrefix("tools.", oraToolIds),
        ...withPrefix("groups.", [
          "overview",
          "tasks",
          "chores",
          "meals",
          "shopping",
          "habits",
          "goals",
          "pets",
          "calendar",
          "photos",
          "home",
          "ora",
        ]),
      ],
      // Ora overviews (S46): looked up by period, module, count, filter, empty-state and status keys.
      OraOverview: [
        ...withPrefix("presets.", ["today", "tomorrow", "thisWeek", "nextWeek"]),
        ...withPrefix("modules.", ["calendar", "tasks", "chores"]),
        ...withPrefix("counts.", ["calendar", "tasks", "chores"]),
        ...withPrefix("completion.", ["open", "done"]),
        ...withPrefix("empty.", ["none", "filtered", "incomplete"]),
        ...withPrefix("openModule.", ["calendar", "tasks"]),
        ...withPrefix("status.", ["done", "overdue", "pending", "open"]),
      ],
      OraSettings: [
        ...withPrefix("palettes.", oraPaletteKeys),
        ...withPrefix("motion.", ["gentle", "reactions", "none"]),
        ...withPrefix("motionHints.", ["gentle", "reactions", "none"]),
        // Ora controls (S47b).
        ...withPrefix("frequency.", ["quiet", "balanced", "active"]),
        ...withPrefix("frequencyHints.", ["quiet", "balanced", "active"]),
        ...withPrefix("categories.", ["reminders", "suggestions", "celebrations"]),
        ...withPrefix("quiet.", ["start", "end"]),
      ],
      // Ora history and memories (S47b): looked up by entry kind and memory key.
      OraHistory: withPrefix("kind.", [
        "task-added",
        "task-undone",
        "shopping-item-added",
        "shopping-item-undone",
      ]),
      OraMemories: withPrefix("key.", ["task-list", "shopping-list"]),
      // Household Displays (S44): widget types, presentation options and outcome codes.
      DisplayBoard: [
        ...withPrefix("widget.", displayWidgetTypes),
        ...withPrefix("lockFail.", [
          "invalidPin",
          "pinLocked",
          "pinNotSet",
          "notPermitted",
          "rateLimited",
          "network",
          "failed",
        ]),
      ],
      DisplayConfig: [
        ...withPrefix("widget.", displayWidgetTypes),
        ...withPrefix("size.", displayWidgetSizes),
        ...withPrefix("orientation.", displayOrientations),
        ...withPrefix("theme.", displayThemes),
        ...withPrefix("density.", displayDensities),
        ...withPrefix("clock.", displayClockFormats),
        ...withPrefix("notice.", ["saved", "restored", "locked", "unlocked", "messageSaved"]),
        ...withPrefix("saveFail.", [
          "signedOut",
          "notPermitted",
          "notFound",
          "invalid",
          "network",
          "failed",
        ]),
      ],
      // Account activity (S38): event codes, categories, results, actors, roles and states, by the
      // value the database answers.
      Activity: [
        ...ALL_ACTIVITY_KINDS.map((kind) => kindKey(kind)),
        ...withPrefix("category.", ACTIVITY_CATEGORIES),
        ...withPrefix("outcome.", ACTIVITY_OUTCOMES),
        ...withPrefix("actor.", ACTIVITY_ACTORS),
        ...withPrefix("role.", ROLE_CODES),
        ...withPrefix("reportStatus.", ["ready", "expired", "discarded"]),
        ...withPrefix("emailState.", [
          "none",
          "queued",
          "sent",
          "failed",
          "skipped",
          "not_configured",
        ]),
        ...withPrefix("notice.", [
          "new_device_sign_in",
          "unfinished_sign_in",
          "signed_in",
          "security_report_ready",
          "other",
        ]),
      ],
      // Each palette colour's name, looked up by its id (S11).
      // S39: looked up by the codes in src/privacy/catalogue.ts.
      Privacy: [
        ...withPrefix("scope.", ["account", "home", "device"]),
        ...withPrefix("step.", REVIEW_STEPS),
        ...withPrefix("stepHint.", REVIEW_STEPS),
        ...withPrefix("reviewExplain.", REVIEW_STEPS),
        ...withPrefix("reviewConsider.", REVIEW_STEPS),
        ...withPrefix("category.", EXPORT_CATEGORIES),
        ...withPrefix("categoryHint.", EXPORT_CATEGORIES),
        ...withPrefix("homeCategory.", HOME_EXPORT_CATEGORIES),
        ...withPrefix("homeCategoryHint.", HOME_EXPORT_CATEGORIES),
        ...withPrefix("status.", EXPORT_STATUSES),
        ...withPrefix("statusHint.", ["failed", "invalidated", "expired"]),
      ],
      // S40 part 2: looked up by the codes in src/privacy/catalogue.ts.
      DataDeletion: [
        ...withPrefix("category.", DELETION_CATEGORIES),
        ...withPrefix("impact.", DELETION_CATEGORIES),
        ...withPrefix("notHere.", UNDELETABLE_CATEGORIES),
        ...withPrefix("notHereReason.", UNDELETABLE_CATEGORIES),
        ...withPrefix("result.", ["completed", "partial", "failed"]),
      ],
      // S40 part 2: looked up by the codes in src/copies/catalogue.ts and the decision outcomes.
      HomeCopies: [
        ...withPrefix("type.", COPY_ITEM_TYPES),
        ...withPrefix("untitled.", COPY_ITEM_TYPES),
        ...withPrefix("itemGone.", COPY_ITEM_TYPES),
        ...withPrefix("explainFiles.", COPY_ITEM_TYPES),
        ...withPrefix("filesCount.", COPY_ITEM_TYPES),
        ...withPrefix("status.", COPY_STATUSES),
        ...withPrefix("outcome.", COPY_OUTCOMES),
        ...withPrefix("endCode.", [...COPY_END_CODES, "other"]),
        ...withPrefix("decided.", [
          "completed",
          "copying",
          "rejected",
          "expired",
          "invalidated",
          "failed",
          "not_pending",
        ]),
      ],
      Accent: accentPalette.map((entry) => entry.id),
      // The names of the preset units, chosen by the quantity's plural form (S29).
      HabitsNumeric: unitMessageKeys,
      // Each recovery state's sentence and staff label, looked up by state (S12b).
      Recovery: [...Object.values(stateKey), ...Object.values(staffStateKey)],
      // A chore's state in words, looked up by state (S21; the main Calendar's overlay too, S32).
      Chores: Object.values(choreStateKey),
      // Points and rewards (S23): kinds, policies, periods, blocks and states, looked up by the
      // value the database answers.
      Dashboard: [
        ...withPrefix("settingPointsView_", ["mine", "shared"]),
        ...withPrefix("settingLeaderboardPeriod_", ["default", "week", "month", "all"]),
        // The Recipes widget's modes (S24).
        ...withPrefix("settingRecipeMode_", ["favorites", "recent", "top_rated", "random"]),
      ],
      Points: [
        ...withPrefix("latePolicy_", ["full", "reduced", "zero"]),
        ...withPrefix("kind_", [
          "chore_award",
          "chore_reversal",
          "bonus",
          "correction",
          "manual_reversal",
          "redemption",
          "refund",
        ]),
        ...withPrefix("period_", ["week", "month", "all"]),
      ],
      Rewards: [
        ...withPrefix("memberPeriod_", ["week", "month", "year", "ever"]),
        ...withPrefix("block_", [
          "archived",
          "disabled",
          "not_started",
          "ended",
          "sold_out",
          "member_limit",
        ]),
        ...withPrefix("blocker_", ["own_request", "no_reviewer"]),
        ...withPrefix("status_", ["pending", "redeemed", "rejected", "cancelled"]),
        ...withPrefix("statusReplacement_", ["pending", "fulfilled", "unable"]),
        ...withPrefix("fulfillment_", ["pending", "fulfilled", "unable"]),
        ...withPrefix("fulfil_", ["fulfilled", "unable", "pending"]),
        ...withPrefix("fulfilTitle_", ["fulfilled", "unable", "pending"]),
        ...withPrefix("replacement_", ["fulfilled", "unable"]),
        ...withPrefix("replacementTitle_", ["fulfilled", "unable"]),
        ...["archive", "restore"].flatMap((action) =>
          ["For", "Title", "Body", "dAnnounce"].map((part) => action + part),
        ),
      ],
      // Personal points and rewards (S28b): entry kinds and limit periods, by the database's value.
      PersonalPoints: [
        ...withPrefix("kind_", ["credit", "correction", "manual_reversal", "redemption", "refund"]),
        ...withPrefix("period_", ["week", "month", "year", "ever"]),
        ...withPrefix("periodLimitLine_", ["week", "month", "year", "ever"]),
      ],
      // Vacation states, changes, reasons, decisions, events and participant actions, looked up
      // by the value the database answers (S22).
      // The shopping repeat frequencies and list access modes (S26).
      Photos: [
        ...withPrefix("access_", ["view", "contribute"]),
        ...withPrefix("widgetSource_", ["photo", "photos", "album"]),
        ...withPrefix("widgetMode_", ["static", "slideshow"]),
        ...withPrefix("widgetFit_", ["contain", "cover"]),
      ],
      Shopping: [
        ...withPrefix("frequency_", ["daily", "weekly", "monthly"]),
        ...withPrefix("access_", ["edit", "check", "view"]),
      ],
      // S33: notices after the OAuth callback and sync states, by their codes.
      GoogleCalendar: [
        ...withPrefix("notice_", connectNotices),
        ...withPrefix("warning_", googleStates),
        // S34: change states, scopes, fields and removed-event kinds, by their codes.
        ...withPrefix("preview_", ["change", "delete", "remove"]),
        ...withPrefix("scope_", googleScopes),
        ...withPrefix("pending_", changeActions),
        ...withPrefix("failed_", changeActions),
        ...withPrefix("field_", googleFields),
        ...changeStates.flatMap((state) => withPrefix(`changeRow_${state}_`, changeActions)),
        ...withPrefix("hidden_", ["event", "series", "following"]),
      ],
      // S42: the guardian's three secret forms, results and field errors by their codes, and the
      // child's capabilities by their ids.
      ChildSignIn: [
        ...["username", "password", "pin"].flatMap((kind) =>
          ["FieldLabel", "FieldHint", "Save"].map((part) => kind + part),
        ),
        ...withPrefix("done.", [
          "username",
          "password",
          "pin",
          "access",
          "cleared",
          "unlocked",
          "ended",
        ]),
        ...withPrefix("errors.", [
          "usernameInvalid",
          "passwordTooShort",
          "passwordTooLong",
          "pinFormat",
          "pinTooSimple",
        ]),
        ...withPrefix("capability.", childCapabilities),
      ],
      // S42 part 3: the young person's claim failures by their codes.
      ChildTransition: withPrefix("fail.", [
        "invalid",
        "invalidEmail",
        "emailTaken",
        "rateLimited",
        "unavailable",
        "network",
        "failed",
      ]),
      // S34: an owner's Google event state on calendar lists.
      Calendar: withPrefix("googleState_", ["saving", "deleting", "conflict", "failed"]),
      // S37: the two-factor actions' titles, and each session's device, by their values.
      Security: [
        ...["enroll", "disable", "regenerate"].flatMap((action) =>
          ["Title", "Explanation", "Submit"].map((part) => action + part),
        ),
        ...withPrefix("browser.", [
          "edge",
          "chrome",
          "firefox",
          "safari",
          "samsung",
          "opera",
          "other",
        ]),
        ...withPrefix("platform.", [
          "windows",
          "macos",
          "ios",
          "ipados",
          "android",
          "linux",
          "chromeos",
          "other",
        ]),
        ...withPrefix("kind.", ["phone", "tablet", "computer", "unknown"]),
      ],
      Vacations: [
        ...withPrefix("status_", ["upcoming", "active", "ended", "cancelled"]),
        ...withPrefix("absence_", ["upcoming", "active", "ended"]),
        ...withPrefix("change_", [
          "paused",
          "resumed",
          "substituted",
          "no_substitute",
          "restored",
          "needs_review",
          "review_cleared",
        ]),
        ...withPrefix("participant_", ["pending", "accepted", "declined", "withdrawn", "expired"]),
        ...withPrefix("ended_", [
          "self",
          "manager",
          "creator",
          "shortened",
          "cancelled",
          "departure",
        ]),
        ...withPrefix("reason_", ["away", "no_substitute", "paused_date", "overdue_before"]),
        ...withPrefix("decided_", ["keep", "skip", "reassign", "reschedule"]),
        ...withPrefix("stateDecision_", ["keep", "skip", "reassign", "reschedule"]),
        ...withPrefix("event_", [
          "created",
          "renamed",
          "invited",
          "added",
          "accepted",
          "declined",
          "withdrawn",
          "removed",
          "invitation_withdrawn",
          "dates_changed",
          "dates_proposed",
          "proposal_accepted",
          "proposal_declined",
          "proposal_withdrawn",
          "shortened",
          "cancelled",
          "home_pause_confirmed",
          "home_pause_removed",
          "reminder_changed",
          "left_home",
        ]),
        ...["withdraw", "remove", "cancelInvitation"].flatMap((action) =>
          ["Action", "Named", "Title", "Body", "Confirm", "Announce"].map((part) => action + part),
        ),
      ],
    };
    expect(unusedKeys([...english.keys()], sources, dynamic)).toEqual([]);
  });
});
