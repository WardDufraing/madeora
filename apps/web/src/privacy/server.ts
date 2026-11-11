import "server-only";

import { z } from "zod";

import { getSecurityAlertPreferences, type Loaded } from "@/activity/server";
import { getVerifiedIdentity } from "@/auth/identity";
import { getAccountSecurity, getMySessions, getMyTrustedDevices } from "@/auth/security-server";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readGoogleConnection } from "@/google-calendar/data";
import { listMyHomes } from "@/homes/server";

import {
  DELETION_CATEGORIES,
  isExportCategory,
  isHomeExportCategory,
  isReviewStep,
  EXPORT_STATUSES,
  type AnyExportCategory,
  type DeletionCategory,
  type ExportKind,
  type ExportStatus,
  type ReviewStep,
} from "./catalogue";

function logFailure(event: string, code: string | undefined): void {
  // Privacy-safe: the error code only, no account, Home or export ids.
  console.error(JSON.stringify({ event, code: code ?? null }));
}

export interface ExportView {
  readonly id: string;
  readonly kind: ExportKind;
  readonly status: ExportStatus;
  readonly categories: readonly AnyExportCategory[];
  readonly allData: boolean;
  /** The Homes in scope the person still belongs to; `homeCount` is how many were chosen. */
  readonly homeIds: readonly string[];
  readonly homeCount: number;
  readonly partial: boolean;
  readonly sizeBytes: number | null;
  /** Records per category and attachment counts, once ready. */
  readonly counts: Readonly<Record<string, number>> | null;
  readonly attachments: number | null;
  readonly omittedAttachments: number | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly generatedAt: string | null;
  readonly expiresAt: string | null;
  readonly downloadedAt: string | null;
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return Object.fromEntries(entries);
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** The signed-in person's own exports of one kind, newest first (of their latest 20). */
export async function listMyExports(kind: ExportKind): Promise<Loaded<readonly ExportView[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_exports");
  if (error) {
    logFailure("privacy.exports_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data
      .filter((row) => row.kind === kind)
      .map((row) => {
        const summary =
          typeof row.summary === "object" && row.summary !== null && !Array.isArray(row.summary)
            ? (row.summary as Record<string, unknown>)
            : null;
        return {
          id: row.id,
          kind,
          status: (EXPORT_STATUSES as readonly string[]).includes(row.status)
            ? (row.status as ExportStatus)
            : "failed",
          categories:
            kind === "home"
              ? row.categories.filter(isHomeExportCategory)
              : row.categories.filter(isExportCategory),
          allData: row.all_data,
          homeIds: row.home_ids,
          homeCount: row.home_count,
          partial: row.partial,
          sizeBytes: numberOf(row.size_bytes),
          counts: summary ? numberRecord(summary.categories) : null,
          attachments: summary ? numberOf(summary.attachments) : null,
          omittedAttachments: summary ? numberOf(summary.omittedAttachments) : null,
          failureCode: row.failure_code || null,
          createdAt: row.created_at,
          generatedAt: row.generated_at || null,
          expiresAt: row.expires_at || null,
          downloadedAt: row.downloaded_at || null,
        };
      }),
  };
}

export interface PrivacyReviewState {
  readonly step: ReviewStep;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** Where the person is in the optional guided review, or null when never started or dismissed. */
export async function getPrivacyReview(): Promise<Loaded<PrivacyReviewState | null>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_privacy_review");
  if (error) {
    logFailure("privacy.review_failed", error.code);
    return { status: "unavailable" };
  }
  const row = data[0];
  if (!row || !isReviewStep(row.step)) return { status: "ok", value: null };
  return {
    status: "ok",
    value: { step: row.step, startedAt: row.started_at, completedAt: row.completed_at || null },
  };
}

export interface HomePrivacyView {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  /** Whether this Home shows a Home-specific name, accent or picture instead of the account's. */
  readonly customName: boolean;
  readonly customAccent: boolean;
  readonly customAvatar: boolean;
}

/** Everything the privacy dashboard and the guided review summarise, from the authoritative sources. */
export interface PrivacyOverview {
  readonly displayName: string | null;
  readonly hasAvatar: boolean;
  readonly homes: Loaded<readonly HomePrivacyView[]>;
  readonly google: Loaded<{
    readonly connected: boolean;
    readonly status: string | null;
    /** How many of the person's Homes see their Google Calendar availability. */
    readonly sharedHomes: number;
  }>;
  readonly security: Awaited<ReturnType<typeof getAccountSecurity>>;
  readonly sessions: Loaded<number>;
  readonly trustedDevices: Loaded<number>;
  readonly alerts: Awaited<ReturnType<typeof getSecurityAlertPreferences>>;
  readonly exports: Loaded<readonly ExportView[]>;
}

async function readHomes(): Promise<Loaded<readonly HomePrivacyView[]>> {
  const identity = await getVerifiedIdentity();
  const homes = await listMyHomes();
  if (!identity || homes.status !== "ok") return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("home_member_profiles")
    .select("home_id, nickname, display_name, accent_color, avatar_file_id")
    .eq("user_id", identity.userId);
  if (error) {
    logFailure("privacy.home_profiles_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: homes.homes.map((home) => {
      const profile = data.find((row) => row.home_id === home.id);
      return {
        id: home.id,
        name: home.name,
        role: home.role,
        customName: Boolean(profile?.display_name || profile?.nickname),
        customAccent: Boolean(profile?.accent_color),
        customAvatar: Boolean(profile?.avatar_file_id),
      };
    }),
  };
}

export async function getPrivacyOverview(): Promise<PrivacyOverview> {
  const supabase = await createSupabaseServerClient();
  const identity = await getVerifiedIdentity();
  const [preferences, homes, google, security, sessions, trusted, alerts, exports] =
    await Promise.all([
      identity
        ? supabase
            .from("user_preferences")
            .select("display_name, avatar_file_id")
            .eq("user_id", identity.userId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      readHomes(),
      readGoogleConnection(),
      getAccountSecurity(),
      getMySessions(),
      getMyTrustedDevices(),
      getSecurityAlertPreferences(),
      listMyExports("personal"),
    ]);
  return {
    displayName: preferences.data?.display_name ?? null,
    hasAvatar: Boolean(preferences.data?.avatar_file_id),
    homes,
    google:
      google.status === "ok"
        ? {
            status: "ok",
            value: {
              connected: google.value !== null,
              status: google.value?.status ?? null,
              sharedHomes: google.value?.homes.length ?? 0,
            },
          }
        : { status: "unavailable" },
    security,
    sessions: sessions.status === "ok" ? { status: "ok", value: sessions.value.length } : sessions,
    trustedDevices:
      trusted.status === "ok" ? { status: "ok", value: trusted.value.length } : trusted,
    alerts,
    exports,
  };
}

export interface HomeExportAccess {
  readonly canGrant: boolean;
  readonly canExport: boolean;
  readonly members: readonly {
    readonly membershipId: string;
    readonly isSelf: boolean;
    readonly role: string;
    readonly granted: boolean;
    readonly canChange: boolean;
  }[];
}

const homeExportAccessShape = z.strictObject({
  canGrant: z.boolean(),
  canExport: z.boolean(),
  members: z.array(
    z.strictObject({
      membershipId: z.uuid(),
      isSelf: z.boolean(),
      role: z.string(),
      granted: z.boolean(),
      canChange: z.boolean(),
    }),
  ),
});

/** Who may export a Home's data (exportHomeData): everyone for the Owner, oneself otherwise. */
export async function getHomeExportAccess(homeId: string): Promise<Loaded<HomeExportAccess>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_home_export_access", { p_home_id: homeId });
  if (error) {
    logFailure("privacy.home_export_access_failed", error.code);
    return { status: "unavailable" };
  }
  const parsed = homeExportAccessShape.safeParse(data);
  if (!parsed.success) {
    logFailure("privacy.home_export_access_failed", "unexpected");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

/** What deleting one category affects (S40 part 2), counted by the database. */
export interface DeletionCategoryPreview {
  readonly items: number;
  readonly inTrash: number;
  readonly shared: number;
  readonly files: number;
  readonly openCopies: number;
}

export interface DeletionPreview {
  readonly categories: Readonly<Record<DeletionCategory, DeletionCategoryPreview>>;
  /** Personal exports in preparation or ready that become unavailable. */
  readonly openExports: number;
}

const countSchema = z.int().min(0).catch(0);
const deletionPreviewSchema = z.object({
  categories: z.record(
    z.enum(DELETION_CATEGORIES),
    z.object({
      items: countSchema,
      inTrash: countSchema,
      shared: countSchema,
      files: countSchema,
      openCopies: countSchema,
    }),
  ),
  openExports: countSchema,
});

/** The impact preview of every deletable category, for the person's own data. */
export async function getDeletionPreview(): Promise<Loaded<DeletionPreview>> {
  if (!(await getVerifiedIdentity())) return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("personal_deletion_preview", {
    p_categories: [...DELETION_CATEGORIES],
  });
  if (error) {
    logFailure("privacy.deletion_preview_failed", error.code);
    return { status: "unavailable" };
  }
  const parsed = deletionPreviewSchema.safeParse(data);
  if (!parsed.success) {
    logFailure("privacy.deletion_preview_failed", "unexpected_result");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}
