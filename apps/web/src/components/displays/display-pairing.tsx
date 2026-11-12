"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { DISPLAY_PATH } from "@/auth/redirects";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { requestPairing, type PairingState } from "@/displays/api";
import { formatPairingCode } from "@/displays/schema";

/** How often the waiting tablet asks whether a manager approved it. */
const POLL_MS = 3_000;
/** After a failure, wait longer before asking again. */
const RETRY_MS = 15_000;

type Screen = PairingState | { readonly status: "loading" };

/**
 * The unregistered tablet's screen (S43; spec: "Before approval, the unregistered screen shows
 * only pairing instructions and its temporary code, no Home information or household controls").
 * It asks the server every few seconds; once a manager approved it, the server sets the display's
 * session and this screen reloads into the display. An expired code offers a new one; the code
 * itself never leaves this screen except as text on it.
 */
export function DisplayPairing() {
  const t = useTranslations("Displays");
  const [screen, setScreen] = useState<Screen>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const askRef = useRef<(renew: boolean) => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (renew: boolean): Promise<void> => {
      if (timer) clearTimeout(timer);
      const next = await requestPairing(renew);
      if (!alive) return;
      if (next.status === "paired") {
        // The session cookies are set: the same address now shows the display.
        window.location.replace(DISPLAY_PATH);
        return;
      }
      setScreen(next);
      if (next.status === "pending") {
        timer = setTimeout(() => {
          void ask(false);
        }, POLL_MS);
      } else if (next.status === "network" || next.status === "unavailable") {
        timer = setTimeout(() => {
          void ask(false);
        }, RETRY_MS);
      }
    };
    askRef.current = ask;
    void ask(false);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const renew = () => {
    if (busy) return;
    setBusy(true);
    void askRef.current(true).finally(() => {
      setBusy(false);
    });
  };

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6" data-testid="display-pairing">
      <h1 className="text-page-title font-semibold text-fg">{t("pairingTitle")}</h1>
      <ol className="list-decimal ps-5 text-start text-body text-fg-muted">
        <li>{t("pairingStep1")}</li>
        <li>{t("pairingStep2")}</li>
        <li>{t("pairingStep3")}</li>
      </ol>
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
        {screen.status === "loading" ? (
          <p className="text-body text-fg-muted">{t("pairingLoading")}</p>
        ) : screen.status === "pending" ? (
          <>
            <p className="text-helper text-fg-muted">{t("pairingCodeLabel")}</p>
            <p
              className="rounded-card border border-line px-6 py-4 font-mono text-[2.5rem] leading-none font-semibold tracking-[0.2em] text-fg"
              data-testid="pairing-code"
              aria-label={t("pairingCodeSpoken", {
                code: screen.code.split("").join(" "),
              })}
            >
              {formatPairingCode(screen.code)}
            </p>
            <p className="text-helper text-fg-muted">{t("pairingWaiting")}</p>
          </>
        ) : screen.status === "expired" ? (
          <FormAlert tone="info">{t("pairingExpired")}</FormAlert>
        ) : screen.status === "rate-limited" ? (
          <FormAlert tone="error">{t("pairingRateLimited")}</FormAlert>
        ) : screen.status === "signed-in" ? (
          <FormAlert tone="info">{t("signedInHere")}</FormAlert>
        ) : (
          <FormAlert tone="error">{t("pairingUnavailable")}</FormAlert>
        )}
      </div>
      {screen.status === "pending" ||
      screen.status === "expired" ||
      screen.status === "rate-limited" ? (
        <Button type="button" variant="secondary" loading={busy} onClick={renew}>
          {t("pairingNewCode")}
        </Button>
      ) : null}
    </div>
  );
}
