/**
 * Loads Cloudflare Turnstile's browser script once per page (ADR 0008). Turnstile runs only where
 * `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set; Supabase Auth checks each token with the secret key.
 */

export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=madeoraTurnstileLoaded";

export interface TurnstileRenderOptions {
  readonly sitekey: string;
  readonly action?: string;
  readonly theme?: "light" | "dark" | "auto";
  readonly language?: string;
  readonly size?: "normal" | "flexible" | "compact";
  readonly "refresh-expired"?: "auto" | "manual" | "never";
  readonly callback?: (token: string) => void;
  readonly "expired-callback"?: () => void;
  // Return true to tell Turnstile the error was handled.
  readonly "error-callback"?: (code: string) => boolean;
}

/** The part of `window.turnstile` Madeora uses. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    madeoraTurnstileLoaded?: () => void;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Resolves with `window.turnstile`, adding the script the first time. Rejects if it fails to load. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    window.madeoraTurnstileLoaded = () => {
      if (window.turnstile) resolve(window.turnstile);
      else fail(new Error("Turnstile loaded without its API"));
    };
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.addEventListener("error", () => {
      script.remove();
      fail(new Error("Turnstile script failed to load"));
    });
    document.head.append(script);

    function fail(error: Error): void {
      // Let a later form try again (for example after the connection comes back).
      loading = null;
      reject(error);
    }
  });
  return loading;
}

/** Test hook: forget a pending or finished load. */
export function resetTurnstileLoaderForTests(): void {
  loading = null;
}
