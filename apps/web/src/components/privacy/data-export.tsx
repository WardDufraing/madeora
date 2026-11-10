"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import type { AccountChangeAction } from "@/auth/google-reauth";
import { reauthenticate } from "@/auth/reauthenticate";
import { reauthenticationSchema, type ReauthenticationValues } from "@/auth/schemas";
import { useCaptcha } from "@/components/auth/captcha";
import { FormAlert } from "@/components/auth/form-alert";
import {
  ConfirmWithGoogle,
  ReauthFields,
  reauthModeFor,
  useReauthMessages,
} from "@/components/security/reauth-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  cancelExport,
  exportDownloadLink,
  PrivacyActionError,
  requestExport,
  requestHomeExport,
  type PrivacyFailure,
} from "@/privacy/api";
import {
  EXPORT_CATEGORIES,
  HOME_EXPORT_CATEGORIES,
  isExportCategory,
  isHomeExportCategory,
  type AnyExportCategory,
  type ExportKind,
  type ExportStatus,
} from "@/privacy/catalogue";
import { exportRequestSchema, homeExportRequestSchema } from "@/privacy/schema";

export interface ExportRow {
  readonly id: string;
  readonly kind: ExportKind;
  readonly status: ExportStatus;
  readonly allData: boolean;
  readonly categories: readonly AnyExportCategory[];
  readonly homeNames: readonly string[];
  /** Chosen Homes the person has left since (named nowhere). */
  readonly formerHomes: number;
  readonly partial: boolean;
  /** Formatted by the server page. */
  readonly requested: string;
  readonly expires: string | null;
  readonly size: string | null;
  readonly downloaded: string | null;
  readonly counts: Readonly<Record<string, number>> | null;
  readonly omittedAttachments: number | null;
  readonly failureCode: string | null;
}

export interface DataExportProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
  readonly storageOn: boolean;
  /** Personal export: the Homes to choose for Home-specific settings and contributions. */
  readonly homes: readonly { readonly id: string; readonly name: string }[];
  /** Home export (S39 part 2): the Home whose data is exported; no Home choice then. */
  readonly home?: { readonly id: string; readonly name: string };
  readonly exports: readonly ExportRow[];
}

interface Selection {
  readonly allData: boolean;
  readonly categories: readonly AnyExportCategory[];
  readonly homeIds: readonly string[];
}

type Pending =
  | { readonly type: "request"; readonly input: Selection }
  | { readonly type: "download"; readonly id: string };

const NEVER_INCLUDED = [
  "neverHomeRecords",
  "neverOthers",
  "neverSecrets",
  "neverSecurity",
  "neverTrash",
] as const;

const NEVER_INCLUDED_HOME = [
  "neverHomeShared",
  "neverHomeHidden",
  "neverHomeMembers",
  "neverSecrets",
  "neverTrash",
] as const;

const REFRESH_MS = 15_000;

/**
 * Settings › Privacy › Export your data (S39, spec "Confirmed comprehensive, category-selective
 * personal data exports"): All eligible data or chosen categories, the Homes whose own
 * contributions and Home-specific settings to include, a preview of what is and is never included,
 * then a fresh "confirm it's you". The export is prepared in the background; this page shows its
 * state (refreshing while it is being prepared) and offers the download, which is checked again
 * on the server with a fresh confirmation.
 */
const SELECTION_KEY = "madeora.privacy.export-selection";

function selectionKey(homeId: string | undefined): string {
  return homeId ? `${SELECTION_KEY}:${homeId}` : SELECTION_KEY;
}

function saveSelection(homeId: string | undefined, input: Selection): void {
  try {
    window.sessionStorage.setItem(selectionKey(homeId), JSON.stringify(input));
  } catch {
    // Storage unavailable (private mode): the choice falls back to the defaults on return.
  }
}

/** The saved choice, read once and removed; anything unexpected is ignored. */
function readSavedSelection(homeId: string | undefined): Selection | null {
  try {
    const raw = window.sessionStorage.getItem(selectionKey(homeId));
    window.sessionStorage.removeItem(selectionKey(homeId));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (homeId) {
      const parsed = homeExportRequestSchema.safeParse(value);
      return parsed.success ? { ...parsed.data, homeIds: [] } : null;
    }
    const parsed = exportRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function DataExport({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  storageOn,
  homes,
  home,
  exports,
}: DataExportProps) {
  const t = useTranslations("Privacy");
  const router = useRouter();
  const formId = useId();
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, "data_export");
  const [allData, setAllData] = useState(true);
  const [categories, setCategories] = useState<readonly AnyExportCategory[]>([]);
  const [homeIds, setHomeIds] = useState<readonly string[]>(
    home ? [] : homes.map((entry) => entry.id),
  );
  const catalogue: readonly AnyExportCategory[] = home ? HOME_EXPORT_CATEGORIES : EXPORT_CATEGORIES;
  const homeId = home?.id;
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const resolver = useMemo(
    () => zodResolver(reauthenticationSchema(twoFactor, mode === "password")),
    [twoFactor, mode],
  );
  const form = useForm<ReauthenticationValues>({
    resolver,
    defaultValues: { password: "", code: "" },
  });

  // Confirming with Google leaves the page; the choice made before it is kept for this tab only and
  // restored on return, so the export prepared is the one the person reviewed.
  useEffect(() => {
    if (confirmed !== "data_export") return;
    const saved = readSavedSelection(homeId);
    if (!saved) return;
    // This tab's storage is known only after mounting (the precedent of recipe-editor.tsx).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllData(saved.allData);
    setCategories(saved.categories);
    setHomeIds(saved.homeIds.filter((id) => homes.some((entry) => entry.id === id)));
  }, [confirmed, homes, homeId]);

  const preparing = exports.some((row) => row.status === "queued" || row.status === "preparing");
  useEffect(() => {
    if (!preparing) return undefined;
    const timer = window.setInterval(() => {
      router.refresh();
    }, REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [preparing, router]);

  const included: readonly AnyExportCategory[] = allData ? catalogue : categories;

  /** A category's name; a Home export's categories have their own wording. */
  function label(kind: ExportKind, category: AnyExportCategory): string {
    if (kind === "home" && isHomeExportCategory(category)) return t(`homeCategory.${category}`);
    if (kind === "personal" && isExportCategory(category)) return t(`category.${category}`);
    return category;
  }

  function hint(category: AnyExportCategory): string {
    if (home && isHomeExportCategory(category)) return t(`homeCategoryHint.${category}`);
    if (!home && isExportCategory(category)) return t(`categoryHint.${category}`);
    return "";
  }

  function failureText(failure: PrivacyFailure, action: Pending["type"] | "cancel"): string {
    switch (failure) {
      case "rateLimited":
        return t("rateLimited");
      case "inProgress":
        return t("inProgress");
      case "invalidated":
        return t("invalidatedNow");
      case "expired":
      case "notFound":
        return t("gone");
      case "storageOff":
        return t("storageOff");
      case "notPermitted":
        return t("homeNotPermitted");
      case "invalid":
        return t("selectionInvalid");
      default:
        return action === "request" ? t("requestFailed") : t("actionFailed");
    }
  }

  /** Runs the action; returns false when a fresh confirmation is needed first. */
  async function perform(action: Pending): Promise<boolean> {
    setBusy(action.type === "request" ? "request" : `${action.id}:download`);
    setMessage(null);
    try {
      if (action.type === "request") {
        await sendRequest(action.input);
        setMessage({ tone: "success", text: t("requested") });
        router.refresh();
      } else {
        const url = await exportDownloadLink(action.id);
        window.location.assign(url);
        router.refresh();
      }
      return true;
    } catch (error) {
      const failure = error instanceof PrivacyActionError ? error.failure : "failed";
      if (failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return true;
      }
      if (failure === "reauthenticate") return false;
      setMessage({ tone: "error", text: failureText(failure, action.type) });
      if (failure === "invalidated") router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function sendRequest(input: Selection): Promise<void> {
    if (home) {
      const parsed = homeExportRequestSchema.safeParse({
        allData: input.allData,
        categories: input.categories,
      });
      if (!parsed.success) throw new PrivacyActionError("invalid");
      await requestHomeExport(home.id, parsed.data);
      return;
    }
    const parsed = exportRequestSchema.safeParse(input);
    if (!parsed.success) throw new PrivacyActionError("invalid");
    await requestExport(parsed.data);
  }

  async function start(action: Pending) {
    // A confirmation from the last two minutes still counts; otherwise ask for one.
    if (await perform(action)) return;
    if (action.type === "request" && mode === "google") saveSelection(homeId, action.input);
    setPending(action);
  }

  const onConfirm = form.handleSubmit(async (values) => {
    if (!pending || mode !== "password" || !captcha.ready) return;
    setMessage(null);
    const failed = await reauthenticate(
      {
        email,
        password: values.password,
        code: twoFactor ? values.code : null,
        captchaOptions: captcha.options,
      },
      (client, sessionId) =>
        client.rpc("authorize_account_change", {
          p_action: "data_export",
          p_session_id: sessionId,
        }),
    );
    captcha.reset();
    form.reset({ password: "", code: "" });
    if (failed) {
      setMessage({ tone: "error", text: reauthMessage(failed) });
      return;
    }
    const action = pending;
    setPending(null);
    if (!(await perform(action))) {
      setMessage({
        tone: "error",
        text: action.type === "request" ? t("requestFailed") : t("actionFailed"),
      });
    }
  });

  async function cancel(id: string) {
    setBusy(`${id}:cancel`);
    setMessage(null);
    try {
      await cancelExport(id);
      setMessage({ tone: "success", text: t("canceled") });
      router.refresh();
    } catch (error) {
      const failure = error instanceof PrivacyActionError ? error.failure : "failed";
      setMessage({ tone: "error", text: failureText(failure, "cancel") });
    } finally {
      setBusy(null);
    }
  }

  function submit() {
    if (!allData && categories.length === 0) {
      setSelectionError(t("selectionEmpty"));
      return;
    }
    if (!home && !allData && categories.includes("home_contributions") && homeIds.length === 0) {
      setSelectionError(t("selectionNoHome"));
      return;
    }
    setSelectionError(null);
    void start({
      type: "request",
      input: { allData, categories: allData ? [] : [...categories], homeIds: [...homeIds] },
    });
  }

  function toggle<T>(list: readonly T[], value: T, on: boolean): readonly T[] {
    return on
      ? [...list.filter((item) => item !== value), value]
      : list.filter((item) => item !== value);
  }

  const confirmIntro = pending?.type === "download" ? t("confirmDownload") : t("confirmRequest");

  return (
    <div className="flex flex-col gap-6" data-testid="data-export">
      {message ? (
        <FormAlert tone={message.tone} announce>
          {message.text}
        </FormAlert>
      ) : null}
      {!storageOn ? <FormAlert tone="info">{t("storageOff")}</FormAlert> : null}

      {pending ? (
        mode === "google" ? (
          <div className="flex flex-col gap-3 rounded-control border border-line p-4">
            <p className="text-body">{confirmIntro}</p>
            <ConfirmWithGoogle
              action="data_export"
              email={email}
              userId={userId}
              twoFactor={twoFactor}
              label={pending.type === "download" ? t("download") : t("request")}
              returnPath={home ? `/homes/${home.id}/export` : undefined}
            />
            <div>
              <Button
                variant="ghost"
                onClick={() => {
                  setPending(null);
                }}
              >
                {t("cancelConfirm")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            method="post"
            noValidate
            aria-label={confirmIntro}
            onSubmit={(event) => {
              void onConfirm(event);
            }}
            className="flex flex-col gap-4 rounded-control border border-line p-4"
          >
            <p className="text-body">{confirmIntro}</p>
            <ReauthFields
              password={form.register("password")}
              code={form.register("code")}
              passwordError={form.formState.errors.password?.message}
              codeError={form.formState.errors.code?.message}
              withCode={twoFactor}
            />
            {captcha.check}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" loading={form.formState.isSubmitting || !captcha.ready}>
                {pending.type === "download" ? t("download") : t("request")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPending(null);
                  form.reset({ password: "", code: "" });
                }}
              >
                {t("cancelConfirm")}
              </Button>
            </div>
          </form>
        )
      ) : (
        <form
          method="post"
          noValidate
          aria-label={t("requestTitle")}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex flex-col gap-5"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body font-medium text-fg">{t("scopeLegend")}</legend>
            {(["all", "choose"] as const).map((value) => (
              <div key={value} className="flex items-start gap-2">
                <input
                  id={`${formId}-${value}`}
                  type="radio"
                  name="scope"
                  value={value}
                  checked={allData === (value === "all")}
                  aria-describedby={`${formId}-${value}-hint`}
                  className="mt-1 size-4 accent-accent"
                  onChange={() => {
                    setAllData(value === "all");
                    setSelectionError(null);
                  }}
                />
                <span className="flex flex-col">
                  <label htmlFor={`${formId}-${value}`} className="text-body text-fg">
                    {value === "all" ? t("scopeAll") : t("scopeChoose")}
                  </label>
                  <span id={`${formId}-${value}-hint`} className="text-helper text-fg-muted">
                    {value === "all" ? t("scopeAllHint") : t("scopeChooseHint")}
                  </span>
                </span>
              </div>
            ))}
          </fieldset>

          {!allData ? (
            <fieldset className="flex flex-col gap-3" aria-describedby={`${formId}-selection`}>
              <legend className="mb-1 text-body font-medium text-fg">
                {t("categoriesLegend")}
              </legend>
              {catalogue.map((category) => (
                <Checkbox
                  key={category}
                  label={label(home ? "home" : "personal", category)}
                  description={hint(category)}
                  checked={categories.includes(category)}
                  onChange={(event) => {
                    setCategories(toggle(categories, category, event.target.checked));
                    setSelectionError(null);
                  }}
                />
              ))}
            </fieldset>
          ) : null}

          {home ? null : (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-body font-medium text-fg">{t("homesLegend")}</legend>
              <p className="text-helper text-fg-muted">{t("homesHint")}</p>
              {homes.length === 0 ? (
                <p className="text-helper text-fg-muted">{t("homesNone")}</p>
              ) : (
                homes.map((entry) => (
                  <Checkbox
                    key={entry.id}
                    label={entry.name}
                    checked={homeIds.includes(entry.id)}
                    onChange={(event) => {
                      setHomeIds(toggle(homeIds, entry.id, event.target.checked));
                      setSelectionError(null);
                    }}
                  />
                ))
              )}
            </fieldset>
          )}

          <div
            id={`${formId}-selection`}
            className="flex flex-col gap-3 rounded-control border border-line p-4"
          >
            <h3 className="text-body font-semibold">{t("previewTitle")}</h3>
            {included.length === 0 ? (
              <p className="text-helper text-fg-muted">{t("previewEmpty")}</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 ps-5 text-body">
                {included.map((category) => (
                  <li key={category}>{label(home ? "home" : "personal", category)}</li>
                ))}
              </ul>
            )}
            <p className="text-helper text-fg-muted">
              {home
                ? t("previewHome", { home: home.name })
                : t("previewHomes", { count: homeIds.length })}
            </p>
            <h4 className="text-body font-medium">{t("neverTitle")}</h4>
            <ul className="flex list-disc flex-col gap-1 ps-5 text-helper text-fg-muted">
              {(home ? NEVER_INCLUDED_HOME : NEVER_INCLUDED).map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
            <p className="text-helper text-fg-muted">{t("formatHint")}</p>
          </div>

          {selectionError ? (
            <FormAlert tone="error" announce>
              {selectionError}
            </FormAlert>
          ) : null}

          <div>
            <Button type="submit" loading={busy === "request"} disabled={!storageOn || preparing}>
              {t("request")}
            </Button>
            {preparing ? <p className="mt-2 text-helper text-fg-muted">{t("inProgress")}</p> : null}
          </div>
        </form>
      )}

      <section aria-labelledby={`${formId}-list`} className="flex flex-col gap-3">
        <h3 id={`${formId}-list`} className="text-body font-semibold">
          {t("listTitle")}
        </h3>
        {exports.length === 0 ? (
          <p className="text-helper text-fg-muted">{t("listEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {exports.map((row) => {
              const name = row.allData
                ? t("rowAll")
                : t("rowCategories", { count: row.categories.length });
              return (
                <li key={row.id} className="flex flex-col gap-2 py-3" data-testid="data-export-row">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-body font-medium">{name}</span>
                    <span className="text-helper text-fg-muted" role="status">
                      {row.status === "ready" && row.expires
                        ? t("readyUntil", { expires: row.expires })
                        : t(`status.${row.status}`)}
                    </span>
                  </div>
                  <p className="text-helper text-fg-muted">
                    {t("requestedAt", { when: row.requested })}
                    {row.homeNames.length > 0
                      ? ` · ${t("rowHomes", { homes: row.homeNames.join(", ") })}`
                      : ""}
                    {row.formerHomes > 0
                      ? ` · ${t("rowFormerHomes", { count: row.formerHomes })}`
                      : ""}
                  </p>
                  {!row.allData ? (
                    <p className="text-helper text-fg-muted">
                      {row.categories.map((category) => label(row.kind, category)).join(", ")}
                    </p>
                  ) : null}
                  {row.status === "ready" && row.counts ? (
                    <p className="text-helper text-fg-muted">
                      {Object.entries(row.counts)
                        .map(([category, count]) =>
                          t("rowCount", {
                            category:
                              isExportCategory(category) || isHomeExportCategory(category)
                                ? label(row.kind, category)
                                : category,
                            count,
                          }),
                        )
                        .join(" · ")}
                      {row.size ? ` · ${row.size}` : ""}
                    </p>
                  ) : null}
                  {row.status === "ready" && row.partial ? (
                    <FormAlert tone="info">
                      {t("partial", { count: row.omittedAttachments ?? 0 })}
                    </FormAlert>
                  ) : null}
                  {row.downloaded ? (
                    <p className="text-helper text-fg-muted">
                      {t("downloadedAt", { when: row.downloaded })}
                    </p>
                  ) : null}
                  {row.status === "failed" ||
                  row.status === "invalidated" ||
                  row.status === "expired" ? (
                    <p className="text-helper text-fg-muted">{t(`statusHint.${row.status}`)}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {row.status === "ready" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t("downloadLabel", { name, when: row.requested })}
                        loading={busy === `${row.id}:download`}
                        disabled={busy !== null || pending !== null}
                        onClick={() => {
                          void start({ type: "download", id: row.id });
                        }}
                      >
                        {t("download")}
                      </Button>
                    ) : null}
                    {row.status === "ready" ||
                    row.status === "queued" ||
                    row.status === "preparing" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={
                          row.status === "ready"
                            ? t("deleteLabel", { name, when: row.requested })
                            : t("cancelLabel", { name, when: row.requested })
                        }
                        loading={busy === `${row.id}:cancel`}
                        disabled={busy !== null}
                        onClick={() => {
                          void cancel(row.id);
                        }}
                      >
                        {row.status === "ready" ? t("delete") : t("cancel")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
