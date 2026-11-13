"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { callOraTool, OraToolError } from "@/ora/tools/client";
import type { Overview, OverviewRequest, OverviewShare } from "@/ora/overview/types";

/**
 * "Share a copy" (S46): prepares a text for one chosen audience, shows it for review and editing,
 * and copies it only when the person presses Copy. Nothing is sent or stored. Any change to the
 * period or filters throws the prepared text away (it must be prepared and reviewed again), and
 * the server rebuilds it from current data every time it is prepared.
 */
export function OraOverviewShare({
  homeId,
  request,
  overview,
}: {
  readonly homeId: string;
  readonly request: OverviewRequest;
  readonly overview: Overview;
}) {
  const t = useTranslations("OraOverview");
  const audiences = overview.members.filter((member) => member.shareable);
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState("");
  // A prepared text belongs to the period, filters and audience it was prepared for: change any of
  // them and it is gone (it must be prepared and reviewed again), with no effect needed.
  const requestKey = JSON.stringify([request, audience]);
  const [stored, setStored] = useState<{
    readonly key: string;
    readonly share: OverviewShare;
    readonly text: string;
  } | null>(null);
  const current = stored?.key === requestKey ? stored : null;
  const prepared = current?.share ?? null;
  const text = current?.text ?? "";
  const [state, setState] = useState<
    "idle" | "working" | "failed" | "invalid" | "copied" | "copyFailed"
  >("idle");

  if (audiences.length === 0) return null;

  async function prepare() {
    if (audience === "") return;
    setState("working");
    try {
      const output = await callOraTool(homeId, "share-overview", { request, audience });
      if (output.kind !== "share") throw new OraToolError("unavailable");
      setStored({ key: requestKey, share: output.share, text: output.share.text });
      setState("idle");
    } catch (error) {
      setStored(null);
      setState(
        error instanceof OraToolError && error.failure === "forbidden" ? "invalid" : "failed",
      );
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("copyFailed");
    }
  }

  return (
    <section
      aria-label={t("share.title")}
      className="flex flex-col gap-2 border-t border-line pt-3"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="ora-share"
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="inline-flex min-h-8 w-fit items-center rounded-control text-helper font-medium text-accent-fg hover:underline"
      >
        {open ? t("share.close") : t("share.open")}
      </button>
      {open ? (
        <div id="ora-share" className="flex flex-col gap-2">
          <p className="text-helper text-fg-muted">{t("share.intro")}</p>
          <SelectField
            label={t("share.audience")}
            value={audience}
            options={[
              { value: "", label: t("share.choose") },
              ...audiences.map((member) => ({
                value: member.id,
                label: member.name ?? t("share.noName"),
              })),
            ]}
            onChange={(event) => {
              setAudience(event.currentTarget.value);
            }}
          />
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={audience === ""}
              loading={state === "working"}
              onClick={() => void prepare()}
            >
              {prepared ? t("share.prepareAgain") : t("share.prepare")}
            </Button>
          </div>
          <div aria-live="polite" className="flex flex-col gap-2">
            {state === "failed" ? (
              <p className="text-helper text-danger">{t("share.failed")}</p>
            ) : null}
            {state === "invalid" ? (
              <p className="text-helper text-danger">{t("share.invalid")}</p>
            ) : null}
            {prepared ? (
              <>
                {prepared.incomplete ? (
                  <p className="text-helper">{t("share.incomplete")}</p>
                ) : null}
                <TextArea
                  label={t("share.textLabel")}
                  value={text}
                  rows={8}
                  onChange={(event) => {
                    const edited = event.currentTarget.value;
                    setStored((previous) => (previous ? { ...previous, text: edited } : previous));
                    setState("idle");
                  }}
                />
                <p className="text-helper text-fg-muted">{t("share.warning")}</p>
                <div>
                  <Button size="sm" onClick={() => void copy()}>
                    {t("share.copy")}
                  </Button>
                </div>
                {state === "copied" ? <p className="text-helper">{t("share.copied")}</p> : null}
                {state === "copyFailed" ? (
                  <p className="text-helper text-danger">{t("share.copyFailed")}</p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
