"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import {
  ActivityActionError,
  discardSecurityReport,
  downloadSecurityReport,
  requestSecurityReport,
  type ActivityFailure,
} from "@/activity/api";
import type { SecurityReportFormat } from "@/activity/schema";
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
import { TextField } from "@/components/ui/text-field";

export interface SecurityReportRow {
  readonly id: string;
  /** "08/10/2026 to 07/11/2026", formatted by the server page. */
  readonly range: string;
  readonly status: "ready" | "expired" | "discarded";
  readonly expires: string;
  readonly downloaded: string | null;
}

export interface SecurityReportSettingProps {
  readonly email: string;
  readonly userId: string;
  readonly twoFactor: boolean;
  readonly hasPassword: boolean;
  readonly confirmed: AccountChangeAction | null;
  readonly timeZone: string;
  /** Today and the first day still within retention, as YYYY-MM-DD in `timeZone`. */
  readonly today: string;
  readonly earliest: string;
  readonly defaultFrom: string;
  readonly reports: readonly SecurityReportRow[];
}

type Pending =
  | { readonly type: "request"; readonly from: string; readonly to: string }
  | { readonly type: "download"; readonly id: string; readonly format: SecurityReportFormat };

/**
 * Settings › Security › Security activity › Security report (S38, spec "Confirmed downloadable
 * adult security activity report"): choose dates within retention, confirm it's you (password
 * and code, or Google), then download CSV or JSON while the report is ready (24 hours). Each
 * download is checked again on the server, with a fresh confirmation when the last one is more
 * than two minutes old. The file is saved straight from memory and never cached.
 */
export function SecurityReportSetting({
  email,
  userId,
  twoFactor,
  hasPassword,
  confirmed,
  timeZone,
  today,
  earliest,
  defaultFrom,
  reports,
}: SecurityReportSettingProps) {
  const t = useTranslations("Activity");
  const router = useRouter();
  const reauthMessage = useReauthMessages();
  const captcha = useCaptcha("reauthenticate");
  const mode = reauthModeFor(hasPassword, confirmed, "security_report");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const resolver = useMemo(
    () => zodResolver(reauthenticationSchema(twoFactor, mode === "password")),
    [twoFactor, mode],
  );
  const form = useForm<ReauthenticationValues>({
    resolver,
    defaultValues: { password: "", code: "" },
  });

  function failureText(failure: ActivityFailure, action: Pending["type"]): string {
    if (failure === "rateLimited") return t("reportRateLimited");
    if (failure === "invalid") return t("reportRangeInvalid");
    if (failure === "notFound") return t("reportGone");
    return action === "request" ? t("reportFailed") : t("reportDownloadFailed");
  }

  /** Runs the action; returns false when a fresh confirmation is needed first. */
  async function perform(action: Pending): Promise<boolean> {
    setBusy(action.type === "request" ? "request" : `${action.id}:${action.format}`);
    setMessage(null);
    try {
      if (action.type === "request") {
        await requestSecurityReport({ from: action.from, to: action.to, timeZone });
        setMessage({ tone: "success", text: t("reportPrepared") });
        router.refresh();
      } else {
        const file = await downloadSecurityReport(action.id, action.format);
        const url = URL.createObjectURL(file.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.fileName;
        link.rel = "noopener";
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        router.refresh();
      }
      return true;
    } catch (error) {
      const failure = error instanceof ActivityActionError ? error.failure : "failed";
      if (failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return true;
      }
      if (failure === "reauthenticate") return false;
      setMessage({ tone: "error", text: failureText(failure, action.type) });
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function start(action: Pending) {
    // A confirmation from the last two minutes still counts; otherwise ask for one.
    if (!(await perform(action))) setPending(action);
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
          p_action: "security_report",
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
        text: action.type === "request" ? t("reportFailed") : t("reportDownloadFailed"),
      });
    }
  });

  async function discard(id: string) {
    setBusy(`${id}:discard`);
    setMessage(null);
    try {
      await discardSecurityReport(id);
      setMessage({ tone: "success", text: t("reportDiscarded") });
      router.refresh();
    } catch (error) {
      const failure = error instanceof ActivityActionError ? error.failure : "failed";
      setMessage({ tone: "error", text: failureText(failure, "download") });
    } finally {
      setBusy(null);
    }
  }

  const rangeValid = from !== "" && to !== "" && from <= to && from >= earliest && to <= today;

  return (
    <div className="flex flex-col gap-5" data-testid="security-report">
      <div className="flex flex-col gap-2 text-helper text-fg-muted">
        <p>{t("reportIncluded")}</p>
        <p>{t("reportExcluded")}</p>
        <p>{t("reportTimeZone", { timeZone })}</p>
      </div>

      {message ? (
        <FormAlert tone={message.tone} announce>
          {message.text}
        </FormAlert>
      ) : null}

      {pending ? (
        mode === "google" ? (
          <div className="flex flex-col gap-3 rounded-control border border-line p-4">
            <p className="text-body">
              {pending.type === "request" ? t("reportConfirmIntro") : t("reportConfirmDownload")}
            </p>
            <ConfirmWithGoogle
              action="security_report"
              email={email}
              userId={userId}
              twoFactor={twoFactor}
              label={pending.type === "request" ? t("reportRequest") : t("downloadCsv")}
            />
            <div>
              <Button
                variant="ghost"
                onClick={() => {
                  setPending(null);
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            method="post"
            noValidate
            aria-label={
              pending.type === "request" ? t("reportConfirmIntro") : t("reportConfirmDownload")
            }
            onSubmit={(event) => {
              void onConfirm(event);
            }}
            className="flex flex-col gap-4 rounded-control border border-line p-4"
          >
            <p className="text-body">
              {pending.type === "request" ? t("reportConfirmIntro") : t("reportConfirmDownload")}
            </p>
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
                {pending.type === "request"
                  ? t("reportRequest")
                  : pending.format === "csv"
                    ? t("downloadCsv")
                    : t("downloadJson")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPending(null);
                  form.reset({ password: "", code: "" });
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        )
      ) : (
        <form
          method="post"
          noValidate
          aria-label={t("reportTitle")}
          onSubmit={(event) => {
            event.preventDefault();
            if (rangeValid) void start({ type: "request", from, to });
            else setMessage({ tone: "error", text: t("reportRangeInvalid") });
          }}
          className="grid max-w-xl gap-4 sm:grid-cols-2"
        >
          <TextField
            label={t("reportFrom")}
            type="date"
            name="from"
            min={earliest}
            max={today}
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
            required
          />
          <TextField
            label={t("reportTo")}
            type="date"
            name="to"
            min={earliest}
            max={today}
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
            required
          />
          <div className="sm:col-span-2">
            <Button type="submit" variant="secondary" loading={busy === "request"}>
              {t("reportRequest")}
            </Button>
          </div>
        </form>
      )}

      <section aria-labelledby="security-reports-heading" className="flex flex-col gap-3">
        <h3 id="security-reports-heading" className="text-body font-semibold">
          {t("reportListTitle")}
        </h3>
        {reports.length === 0 ? (
          <p className="text-helper text-fg-muted">{t("reportNone")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {reports.map((report) => (
              <li
                key={report.id}
                className="flex flex-col gap-2 py-3"
                data-testid="security-report-row"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-body font-medium">{report.range}</span>
                  <span className="text-helper text-fg-muted">
                    {report.status === "ready"
                      ? t("reportReadyUntil", { expires: report.expires })
                      : t(`reportStatus.${report.status}`)}
                  </span>
                </div>
                {report.downloaded ? (
                  <p className="text-helper text-fg-muted">
                    {t("reportDownloadedAt", { when: report.downloaded })}
                  </p>
                ) : null}
                {report.status === "ready" ? (
                  <div className="flex flex-wrap gap-2">
                    {(["csv", "json"] as const).map((format) => (
                      <Button
                        key={format}
                        size="sm"
                        variant="secondary"
                        aria-label={t("downloadLabel", {
                          range: report.range,
                          format: format.toUpperCase(),
                        })}
                        loading={busy === `${report.id}:${format}`}
                        disabled={busy !== null || pending !== null}
                        onClick={() => {
                          void start({ type: "download", id: report.id, format });
                        }}
                      >
                        {format === "csv" ? t("downloadCsv") : t("downloadJson")}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("discardLabel", { range: report.range })}
                      loading={busy === `${report.id}:discard`}
                      disabled={busy !== null}
                      onClick={() => {
                        void discard(report.id);
                      }}
                    >
                      {t("discard")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
