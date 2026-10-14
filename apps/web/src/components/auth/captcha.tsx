"use client";

import { getTurnstileSiteKey } from "@madeora/config/env/public";
import { useLocale, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { loadTurnstile } from "@/auth/turnstile";

import { FormAlert } from "./form-alert";

/** Where the check runs; shown in Cloudflare's Turnstile analytics. */
export type CaptchaAction = "sign-in" | "sign-up" | "forgot-password" | "resend-confirmation";

export interface TurnstileCheckHandle {
  /** Clears the current token and asks Turnstile for a new one. */
  reset(): void;
}

export interface TurnstileCheckProps {
  readonly siteKey: string;
  readonly action: CaptchaAction;
  /** Called with each new token, and with `null` when the token expires, fails or is reset. */
  readonly onTokenChange: (token: string | null) => void;
  readonly ref?: Ref<TurnstileCheckHandle>;
}

/**
 * Cloudflare Turnstile's check (ADR 0008). Turnstile draws and labels its own widget; this
 * component only places it and says so when it cannot load. Supabase Auth verifies the token.
 */
export function TurnstileCheck({ siteKey, action, onTokenChange, ref }: TurnstileCheckProps) {
  const t = useTranslations("Auth");
  const locale = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const onTokenChangeRef = useRef(onTokenChange);
  useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  });

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        setHasToken(false);
        onTokenChangeRef.current(null);
        if (widgetId.current) window.turnstile?.reset(widgetId.current);
      },
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(
      (api) => {
        if (cancelled || !container.current) return;
        widgetId.current =
          api.render(container.current, {
            sitekey: siteKey,
            action,
            theme: pageTheme(),
            language: locale,
            size: "flexible",
            "refresh-expired": "auto",
            callback: (token) => {
              setUnavailable(false);
              setHasToken(true);
              onTokenChangeRef.current(token);
            },
            "expired-callback": () => {
              setHasToken(false);
              onTokenChangeRef.current(null);
            },
            "error-callback": () => {
              setHasToken(false);
              onTokenChangeRef.current(null);
              setUnavailable(true);
              // Handled here; Turnstile keeps retrying on its own.
              return true;
            },
          }) ?? null;
      },
      () => {
        if (!cancelled) setUnavailable(true);
      },
    );
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
      onTokenChangeRef.current(null);
    };
  }, [siteKey, action, locale]);

  return (
    <div className="flex flex-col gap-2">
      <div ref={container} data-testid="turnstile-check" />
      {unavailable ? (
        <FormAlert tone="error" announce>
          {t("captchaUnavailable")}
        </FormAlert>
      ) : (
        // Says why the submit button is busy; Turnstile's own widget lives in a cross-origin frame.
        <p role="status" className="text-helper text-fg-muted">
          {hasToken ? null : t("captchaPending")}
        </p>
      )}
    </div>
  );
}

/** The app's chosen theme on `<html data-theme>`; without one, Turnstile follows the device. */
function pageTheme(): "light" | "dark" | "auto" {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "auto";
}

export interface Captcha {
  /** True when the form may be sent: no Turnstile configured, or a token is ready. */
  readonly ready: boolean;
  /** Spread into a Supabase Auth request's options: `{ captchaToken }`, or nothing without a token. */
  readonly options: { readonly captchaToken?: string };
  /** Tokens are single-use: call after every request that sent one. */
  readonly reset: () => void;
  /** The Turnstile check to place in the form, or null without Turnstile. */
  readonly check: ReactNode;
}

/**
 * Turnstile for one auth form. Without `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (local, CI, previews) it
 * does nothing; with it, the form waits for a token and sends it with its Supabase Auth request.
 */
export function useCaptcha(action: CaptchaAction): Captcha {
  const siteKey = getTurnstileSiteKey();
  const [token, setToken] = useState<string | null>(null);
  const handle = useRef<TurnstileCheckHandle>(null);
  const reset = useCallback(() => {
    handle.current?.reset();
  }, []);

  if (siteKey === undefined) {
    return { ready: true, options: {}, reset, check: null };
  }
  return {
    ready: token !== null,
    options: token === null ? {} : { captchaToken: token },
    reset,
    check: (
      <TurnstileCheck ref={handle} siteKey={siteKey} action={action} onTokenChange={setToken} />
    ),
  };
}
