"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { PrivacyActionError, saveReview } from "@/privacy/api";
import { REVIEW_STEPS, type ReviewStep } from "@/privacy/catalogue";

export interface PrivacyReviewProps {
  /** Saved progress, or null when never started (or dismissed). */
  readonly state: { readonly step: ReviewStep; readonly completed: boolean } | null;
  readonly unavailable: boolean;
  /** Each step's current values, rendered by the server from the authoritative settings. */
  readonly panels: Readonly<Record<ReviewStep, ReactNode>>;
  /** Where "Change setting" leads for each step (the first linked setting), if anywhere. */
  readonly changeLinks: Readonly<Record<ReviewStep, string | null>>;
}

/**
 * The optional guided privacy review (S39): one topic per step with the current values, scope and
 * consequence; Keep as is, Change setting (opens the existing, authoritative control; progress is
 * saved first so the review resumes here), Back, Skip and Finish. Only the step reached is saved
 * (no copies of settings); finishing records that the review was done and changes nothing else.
 */
export function PrivacyReview({ state, unavailable, panels, changeLinks }: PrivacyReviewProps) {
  const t = useTranslations("Privacy");
  const router = useRouter();
  const [step, setStep] = useState<ReviewStep | null>(
    state && !state.completed ? state.step : null,
  );
  const [done, setDone] = useState(state?.completed ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Move focus to the new step's heading, so keyboard and screen-reader users follow the progress.
  useEffect(() => {
    if (step) heading.current?.focus();
  }, [step]);

  async function save(action: Parameters<typeof saveReview>[0]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await saveReview(action);
      return true;
    } catch (failure) {
      if (failure instanceof PrivacyActionError && failure.failure === "signedOut") {
        window.location.assign(new URL("/sign-in", window.location.origin));
        return false;
      }
      // The step did not move: say so rather than pretending it did.
      setError(t("reviewSaveFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    if (await save({ action: "start" })) {
      setDone(false);
      setStep("profile");
    }
  }

  async function goTo(next: ReviewStep) {
    if (await save({ action: "step", step: next })) setStep(next);
  }

  async function finish() {
    if (await save({ action: "finish" })) {
      setStep(null);
      setDone(true);
      router.refresh();
    }
  }

  if (step === null) {
    return (
      <div className="flex flex-col gap-4" data-testid="privacy-review">
        {unavailable ? <FormAlert tone="error">{t("unavailable")}</FormAlert> : null}
        {error ? (
          <FormAlert tone="error" announce>
            {error}
          </FormAlert>
        ) : null}
        <p className="text-body">{done ? t("reviewDone") : t("reviewOptional")}</p>
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => {
              void begin();
            }}
            loading={busy}
          >
            {done ? t("reviewRestart") : t("reviewStart")}
          </Button>
          <Link href="/settings/privacy" className="self-center text-body text-accent-fg underline">
            {t("backToPrivacy")}
          </Link>
        </div>
      </div>
    );
  }

  const index = REVIEW_STEPS.indexOf(step);
  const last = index === REVIEW_STEPS.length - 1;
  const next = REVIEW_STEPS[index + 1];
  const previous = REVIEW_STEPS[index - 1];
  const change = changeLinks[step];

  async function advance() {
    if (last) await finish();
    else if (next) await goTo(next);
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-card border border-line p-4"
      aria-labelledby="privacy-review-step"
      data-testid="privacy-review"
    >
      <p className="text-helper text-fg-muted" aria-live="polite">
        {t("reviewProgress", { step: index + 1, total: REVIEW_STEPS.length })}
      </p>
      <progress
        className="h-2 w-full accent-accent"
        max={REVIEW_STEPS.length}
        value={index + 1}
        aria-label={t("reviewProgress", { step: index + 1, total: REVIEW_STEPS.length })}
      />
      <h2 id="privacy-review-step" ref={heading} tabIndex={-1} className="text-title outline-none">
        {t(`step.${step}`)}
      </h2>
      <p className="text-body">{t(`reviewExplain.${step}`)}</p>
      <p className="text-helper text-fg-muted">{t(`reviewConsider.${step}`)}</p>
      {panels[step]}
      {error ? (
        <FormAlert tone="error" announce>
          {error}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            void advance();
          }}
          loading={busy}
          data-testid="privacy-review-keep"
        >
          {last ? t("reviewFinish") : t("reviewKeep")}
        </Button>
        {change ? (
          <Link
            href={change}
            className="inline-flex items-center rounded-control border border-line px-3 text-body text-accent-fg"
          >
            {t("reviewChange")}
          </Link>
        ) : null}
        {previous ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void goTo(previous);
            }}
          >
            {t("reviewBack")}
          </Button>
        ) : null}
        {!last ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (next) void goTo(next);
            }}
          >
            {t("reviewSkip")}
          </Button>
        ) : null}
        <Link
          href="/settings/privacy"
          className="inline-flex items-center px-3 text-body text-accent-fg underline"
        >
          {t("reviewLater")}
        </Link>
      </div>
    </section>
  );
}
