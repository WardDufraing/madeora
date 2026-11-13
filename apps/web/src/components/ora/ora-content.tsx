"use client";

import { CheckIcon, ChevronDownIcon, HelpIcon, SettingsIcon } from "@madeora/icons";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { contextHref, primaryNav } from "@/components/shell/nav-items";
import { saveOraSettings } from "@/ora/api";
import { callOraTool, fetchOraTools, isInternalPath, OraToolError } from "@/ora/tools/client";
import type { OraToolId } from "@/ora/tools/ids";
import type { OraToolGroup, OraToolSummary } from "@/ora/tools/types";
import type { OverviewTarget } from "@/ora/overview/types";
import type { OraIntroState } from "@/ora/types";

import { OraOverview } from "./ora-overview";

export type OraStatus = "idle" | "working" | "problem";

export interface OraContentProps {
  readonly userId: string;
  /** `null`: Personal space. */
  readonly homeId: string | null;
  readonly homeName: string | null;
  readonly intro: OraIntroState;
  /** Only while the surface is open does Ora ask the server for anything. */
  readonly active: boolean;
  readonly onIntroSettled: (state: "completed" | "skipped") => void;
  /** Leaves the panel after navigating (the page behind it changes). */
  readonly onNavigated: () => void;
  readonly onStatus: (status: OraStatus) => void;
  /** A page asked for the overview (the dashboard widget): a new `id` re-opens it. */
  readonly requested?: { readonly id: number; readonly target: OverviewTarget } | null;
}

const moduleGroups: readonly OraToolGroup[] = [
  "tasks",
  "chores",
  "meals",
  "shopping",
  "habits",
  "goals",
  "pets",
  "calendar",
  "photos",
];

const subscribeOnline = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};
const isOnline = () => navigator.onLine;

type View = "main" | "browse" | "help" | "overview";

/**
 * What Ora shows in its bubble or sheet: a greeting, quick actions, "browse all actions", the
 * "What Ora can do" help view, the first-use introduction, and the calm unavailable state.
 * There is no free-text input and Ora changes no data here: every button opens a page the person
 * may use, offered by the server for exactly this person and place. The component is keyed by
 * context in its parent, so nothing from another Home or the Personal space carries over.
 */
export function OraContent({
  userId,
  homeId,
  homeName,
  intro,
  active,
  onIntroSettled,
  onNavigated,
  onStatus,
  requested = null,
}: OraContentProps) {
  const t = useTranslations("Ora");
  const tNav = useTranslations("Nav");
  const router = useRouter();
  const format = useFormatter();
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const [view, setView] = useState<View>("main");
  const [pending, setPending] = useState<OraToolId | null>(null);
  const [failed, setFailed] = useState(false);
  const [example, setExample] = useState<readonly OraToolSummary[] | null>(null);
  const [introFailed, setIntroFailed] = useState(false);
  const [overviewTarget, setOverviewTarget] = useState<OverviewTarget>("today");
  const [handled, setHandled] = useState(0);
  // A page (the dashboard widget) asked for the overview: show it, once per request.
  if (requested && requested.id !== handled) {
    setHandled(requested.id);
    setOverviewTarget(requested.target);
    setView("overview");
  }

  const tools = useQuery({
    queryKey: ["ora", "tools", userId, homeId ?? "personal"],
    queryFn: () => fetchOraTools(homeId),
    enabled: active,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const forbidden = tools.error instanceof OraToolError && tools.error.failure === "forbidden";
  const unavailable = tools.isError && !forbidden;
  const available = tools.data ?? [];
  const status: OraStatus =
    pending !== null || tools.isFetching ? "working" : unavailable || failed ? "problem" : "idle";
  useEffect(() => {
    onStatus(active ? status : "idle");
  }, [active, status, onStatus]);

  const contextName = homeId === null ? t("contextPersonal") : (homeName ?? t("contextThisHome"));
  const toolLabel = (id: OraToolId) => t(`tools.${id}`);

  async function run(id: OraToolId) {
    if (id === "overview") {
      setOverviewTarget("today");
      setView("overview");
      return;
    }
    setPending(id);
    setFailed(false);
    try {
      const output = await callOraTool(homeId, id);
      if (output.kind === "navigate" && isInternalPath(output.href)) {
        router.push(output.href);
        onNavigated();
      } else if (output.kind === "capabilities") {
        setExample(output.tools);
      }
    } catch (error) {
      setFailed(true);
      // Permissions may have changed: ask the server again what is on offer.
      if (error instanceof OraToolError && error.failure === "forbidden") void tools.refetch();
    } finally {
      setPending(null);
    }
  }

  async function settleIntro(state: "completed" | "skipped") {
    setIntroFailed(false);
    try {
      await saveOraSettings({ intro: state });
      onIntroSettled(state);
    } catch {
      // Never blocks Ora: the introduction simply stays until it can be saved.
      setIntroFailed(true);
    }
  }

  if (!online || unavailable) {
    return (
      <div role="status" className="flex flex-col gap-3" data-testid="ora-unavailable">
        <h3 className="text-body font-semibold">
          {online ? t("unavailable.title") : t("unavailable.offlineTitle")}
        </h3>
        <p className="text-helper text-fg-muted">
          {online ? t("unavailable.body") : t("unavailable.offlineBody")}
        </p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={tools.isFetching}
            disabled={!online}
            onClick={() => void tools.refetch()}
          >
            {t("unavailable.retry")}
          </Button>
        </div>
        <ul className="flex flex-wrap gap-2" aria-label={t("unavailable.pagesLabel")}>
          {primaryNav.slice(0, 5).map((item) => (
            <li key={item.id}>
              <Link
                href={contextHref(item, homeId)}
                onClick={onNavigated}
                className="inline-flex min-h-8 items-center rounded-control border border-line-control px-3 text-helper text-fg hover:bg-accent-subtle"
              >
                {tNav(item.id)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div role="status" className="flex flex-col gap-2" data-testid="ora-forbidden">
        <h3 className="text-body font-semibold">{t("forbidden.title")}</h3>
        <p className="text-helper text-fg-muted">{t("forbidden.body")}</p>
      </div>
    );
  }

  if (tools.isPending) {
    return (
      <p role="status" className="text-helper text-fg-muted">
        {t("loading")}
      </p>
    );
  }

  if (view === "overview" && available.some((tool) => tool.id === "overview")) {
    return (
      <OraOverview
        key={`${overviewTarget}-${String(handled)}`}
        userId={userId}
        homeId={homeId}
        contextName={contextName}
        initialTarget={overviewTarget}
        onBack={() => {
          setView("main");
        }}
        onNavigated={onNavigated}
        onStatus={onStatus}
      />
    );
  }

  if (view === "help") {
    return (
      <HelpView
        tools={available}
        contextName={contextName}
        toolLabel={toolLabel}
        onBack={() => {
          setView("main");
        }}
      />
    );
  }

  const quick = available.filter((tool) => tool.quick);
  const showIntro = intro === null;
  const modules = moduleGroups
    .filter((group) => available.some((tool) => tool.group === group))
    .map((group) => t(`groups.${group}`));

  return (
    <div className="flex flex-col gap-4">
      {showIntro ? (
        <section
          aria-labelledby="ora-intro-title"
          className="flex flex-col gap-3 rounded-card border border-line bg-accent-subtle p-4"
          data-testid="ora-intro"
        >
          <h3 id="ora-intro-title" className="text-body font-semibold">
            {t("intro.title")}
          </h3>
          <p className="text-helper">{t("intro.lead", { context: contextName })}</p>
          <ul className="list-disc ps-5 text-helper">
            {modules.length > 0 ? (
              <li>
                {t("intro.takeYou", {
                  modules: format.list(modules, { type: "conjunction" }),
                })}
              </li>
            ) : null}
            <li>{t("intro.onlyAllowed")}</li>
            <li>{t("intro.noChanges")}</li>
          </ul>
          {example ? (
            <div aria-live="polite">
              <p className="text-helper font-medium">{t("intro.exampleTitle")}</p>
              <ul className="list-disc ps-5 text-helper">
                {example
                  .filter((tool) => tool.kind === "navigate")
                  .map((tool) => (
                    <li key={tool.id}>{toolLabel(tool.id)}</li>
                  ))}
              </ul>
            </div>
          ) : null}
          {introFailed ? (
            <p role="alert" className="text-helper text-danger">
              {t("intro.saveFailed")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {example ? null : (
              <Button
                variant="secondary"
                size="sm"
                loading={pending === "capabilities"}
                onClick={() => void run("capabilities")}
              >
                {t("intro.tryExample")}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void settleIntro("skipped")}>
              {t("intro.skip")}
            </Button>
            <Button size="sm" onClick={() => void settleIntro("completed")}>
              {t("intro.done")}
            </Button>
          </div>
        </section>
      ) : null}

      <p className="text-body">
        {homeId === null
          ? t("greetingPersonal")
          : t("greetingHome", { home: homeName ?? t("contextThisHome") })}
      </p>

      {/* No suggestions exist yet (they arrive with S47): say so calmly instead of filling the space. */}
      <p className="text-helper text-fg-muted">{t("empty")}</p>

      {failed ? (
        <p role="alert" className="text-helper text-danger">
          {t("actionFailed")}
        </p>
      ) : null}

      {quick.length > 0 ? (
        <section aria-labelledby="ora-quick-title" className="flex flex-col gap-2">
          <h3 id="ora-quick-title" className="text-helper font-semibold text-fg-muted">
            {t("quickActions")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {quick.map((tool) => (
              <li key={tool.id}>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pending === tool.id}
                  onClick={() => void run(tool.id)}
                >
                  {toolLabel(tool.id)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {available.some((tool) => tool.kind === "navigate") ? (
        <div>
          <button
            type="button"
            aria-expanded={view === "browse"}
            aria-controls="ora-browse"
            onClick={() => {
              setView(view === "browse" ? "main" : "browse");
            }}
            className="inline-flex min-h-8 items-center gap-1 rounded-control text-helper font-medium text-accent-fg hover:underline"
          >
            {view === "browse" ? t("browseFewer") : t("browseAll")}
            <ChevronDownIcon
              size="sm"
              className={cx("transition-transform", view === "browse" && "rotate-180")}
            />
          </button>
          {view === "browse" ? (
            <div id="ora-browse" className="mt-2 flex flex-col gap-3">
              <GroupedTools
                tools={available.filter((tool) => tool.kind === "navigate")}
                toolLabel={toolLabel}
                pending={pending}
                onRun={(id) => void run(id)}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3">
        <button
          type="button"
          onClick={() => {
            setView("help");
          }}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-control text-helper text-fg hover:underline"
        >
          <HelpIcon size="sm" />
          {t("help.open")}
        </button>
        <Link
          href="/settings/ora"
          onClick={onNavigated}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-control text-helper text-fg hover:underline"
        >
          <SettingsIcon size="sm" />
          {t("settingsLink")}
        </Link>
      </div>
    </div>
  );
}

function GroupedTools({
  tools,
  toolLabel,
  pending,
  onRun,
}: {
  readonly tools: readonly OraToolSummary[];
  readonly toolLabel: (id: OraToolId) => string;
  readonly pending: OraToolId | null;
  readonly onRun: (id: OraToolId) => void;
}) {
  const t = useTranslations("Ora");
  const groups = [...new Set(tools.map((tool) => tool.group))];
  return (
    <>
      {groups.map((group) => (
        <section key={group} aria-label={t(`groups.${group}`)} className="flex flex-col gap-1.5">
          <h4 className="text-helper font-semibold text-fg-muted">{t(`groups.${group}`)}</h4>
          <ul className="flex flex-wrap gap-2">
            {tools
              .filter((tool) => tool.group === group)
              .map((tool) => (
                <li key={tool.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pending === tool.id}
                    onClick={() => {
                      onRun(tool.id);
                    }}
                    className="border border-line"
                  >
                    {toolLabel(tool.id)}
                  </Button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function HelpView({
  tools,
  contextName,
  toolLabel,
  onBack,
}: {
  readonly tools: readonly OraToolSummary[];
  readonly contextName: string;
  readonly toolLabel: (id: OraToolId) => string;
  readonly onBack: () => void;
}) {
  const t = useTranslations("Ora");
  const navigate = tools.filter((tool) => tool.kind === "navigate");
  const groups = [...new Set(navigate.map((tool) => tool.group))];
  return (
    <div className="flex flex-col gap-3" data-testid="ora-help">
      <h3 className="text-body font-semibold">{t("help.title")}</h3>
      <p className="text-helper">{t("help.intro", { context: contextName })}</p>
      <ul className="flex flex-col gap-2">
        {groups.map((group) => (
          <li key={group} className="text-helper">
            <span className="font-medium">{t(`groups.${group}`)}: </span>
            {navigate
              .filter((tool) => tool.group === group)
              .map((tool) => toolLabel(tool.id))
              .join(", ")}
          </li>
        ))}
      </ul>
      <p className="text-helper text-fg-muted">{t("help.limits")}</p>
      <div>
        <Button variant="secondary" size="sm" icon={<CheckIcon size="sm" />} onClick={onBack}>
          {t("help.back")}
        </Button>
      </div>
    </div>
  );
}
