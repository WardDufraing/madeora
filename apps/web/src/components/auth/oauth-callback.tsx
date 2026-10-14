"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { classifyAuthError } from "@/auth/auth-errors";
import { safeNextPath } from "@/auth/redirects";
import {
  LINK_STARTED_BY_KEY,
  classifyCallbackError,
  parseOAuthFlow,
  type CallbackFailure,
} from "@/auth/sign-in-methods";
import { getSupabaseBrowserClient } from "@/auth/supabase-browser";

import { FormAlert } from "./form-alert";

type Outcome =
  | { readonly kind: "working" }
  | { readonly kind: "sign-in-failed"; readonly failure: CallbackFailure }
  | { readonly kind: "link-failed"; readonly failure: CallbackFailure }
  | { readonly kind: "link-account-changed" };

function readStartedBy(): string | null {
  try {
    const value = window.sessionStorage.getItem(LINK_STARTED_BY_KEY);
    window.sessionStorage.removeItem(LINK_STARTED_BY_KEY);
    return value;
  } catch {
    return null;
  }
}

async function finish(): Promise<Outcome | null> {
  const params = new URLSearchParams(window.location.search);
  const flow = parseOAuthFlow(params.get("flow"));
  const next = safeNextPath(params.get("next"));
  const failure = classifyCallbackError(params);
  // The one-time code and any error text leave the address bar (and the history) at once.
  window.history.replaceState(window.history.state, "", window.location.pathname);
  const supabase = getSupabaseBrowserClient();

  if (flow === "link") {
    // Linking never swaps sessions: Supabase Auth has already attached Google (or refused) for the
    // account that started it. This browser only checks the result for the account it is signed in
    // to now, which must be that same account (a shared device may have switched meanwhile).
    const startedBy = readStartedBy();
    if (failure) return { kind: "link-failed", failure };
    const { data, error } = await supabase.auth.getUser();
    if (error || startedBy === null || data.user.id !== startedBy) {
      return { kind: "link-account-changed" };
    }
    if (!(data.user.identities ?? []).some((identity) => identity.provider === "google")) {
      return { kind: "link-failed", failure: "failed" };
    }
    window.location.assign(
      new URL("/settings?linked=google#sign-in-methods", window.location.origin),
    );
    return null;
  }

  if (failure) return { kind: "sign-in-failed", failure };
  const code = params.get("code");
  if (code === null || code === "") return { kind: "sign-in-failed", failure: "expired" };
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const kind = classifyAuthError(error);
    return {
      kind: "sign-in-failed",
      failure:
        kind === "linkInvalid" ? "expired" : kind === "signUpClosed" ? "signUpClosed" : "failed",
    };
  }
  // A full page load, so the server checks the new session and every client cache starts empty.
  window.location.assign(new URL(next, window.location.origin));
  return null;
}

/** Finishes a Google sign-in or link in the browser, then moves on or explains what went wrong. */
export function OAuthCallback() {
  const t = useTranslations("Auth");
  const tMethods = useTranslations("SignInMethods");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    // The code is single-use: never run twice (React may mount effects twice in development).
    if (started.current) return;
    started.current = true;
    finish().then(
      (result) => {
        if (result) setOutcome(result);
      },
      () => {
        setOutcome({ kind: "sign-in-failed", failure: "failed" });
      },
    );
  }, []);

  if (outcome.kind === "working") {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("googleWorking")}
      </p>
    );
  }

  if (outcome.kind === "sign-in-failed") {
    const messages: Record<CallbackFailure, string> = {
      cancelled: t("googleCancelled"),
      expired: t("googleExpired"),
      signUpClosed: t("signUpClosed"),
      alreadyLinked: t("googleFailed"),
      unavailable: t("googleUnavailable"),
      failed: t("googleFailed"),
    };
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone={outcome.failure === "cancelled" ? "info" : "error"} announce>
          {messages[outcome.failure]}
        </FormAlert>
        <Link href="/sign-in" className="text-body font-medium text-accent-fg underline">
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  const linkMessages: Record<CallbackFailure, string> = {
    cancelled: tMethods("linkCancelled"),
    expired: tMethods("linkExpired"),
    signUpClosed: tMethods("linkFailed"),
    alreadyLinked: tMethods("linkAlreadyLinked"),
    unavailable: tMethods("unavailable"),
    failed: tMethods("linkFailed"),
  };
  return (
    <div className="flex flex-col gap-4">
      <FormAlert
        tone={outcome.kind === "link-failed" && outcome.failure === "cancelled" ? "info" : "error"}
        announce
      >
        {outcome.kind === "link-account-changed"
          ? tMethods("linkAccountChanged")
          : linkMessages[outcome.failure]}
      </FormAlert>
      <Link
        href="/settings#sign-in-methods"
        className="text-body font-medium text-accent-fg underline"
      >
        {tMethods("backToSettings")}
      </Link>
    </div>
  );
}
