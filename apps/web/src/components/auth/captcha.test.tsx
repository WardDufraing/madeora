import { AuthApiError } from "@supabase/supabase-js";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  TURNSTILE_SCRIPT_URL,
  loadTurnstile,
  resetTurnstileLoaderForTests,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from "@/auth/turnstile";
import { renderWithIntl } from "@/test/intl";

import { ForgotPasswordForm } from "./forgot-password-form";
import { ResendConfirmation } from "./resend-confirmation";
import { SignInForm } from "./sign-in-form";
import { SignUpForm } from "./sign-up-form";

const signInWithPassword = vi.fn();
const memoryAuth = { signUp: vi.fn(), resend: vi.fn(), resetPasswordForEmail: vi.fn() };
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({ auth: { signInWithPassword } }),
  getMemoryOnlySupabaseClient: () => ({ auth: memoryAuth }),
}));
vi.mock("@/auth/email-links", () => ({ emailLinkTarget: () => "http://app.test/auth/confirm" }));

// Cloudflare's documented always-passing test site key.
const siteKey = "1x00000000000000000000AA";

/** A stand-in for `window.turnstile` that records each widget and lets a test play Cloudflare. */
function fakeTurnstile() {
  const widgets: TurnstileRenderOptions[] = [];
  const api = {
    render: vi.fn((_container: HTMLElement, options: TurnstileRenderOptions) => {
      widgets.push(options);
      return `widget-${String(widgets.length)}`;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  } satisfies TurnstileApi;
  return {
    api,
    widget: (index = 0) => {
      const options = widgets[index];
      if (!options) throw new Error(`no widget ${String(index)}`);
      return options;
    },
    /** Turnstile finished its check for widget `index`. */
    solve: (token: string, index = 0) => {
      act(() => {
        widgets[index]?.callback?.(token);
      });
    },
  };
}

let turnstile: ReturnType<typeof fakeTurnstile>;

beforeEach(() => {
  turnstile = fakeTurnstile();
  window.turnstile = turnstile.api;
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", siteKey);
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  memoryAuth.signUp.mockReset().mockResolvedValue({ error: null });
  memoryAuth.resend.mockReset().mockResolvedValue({ error: null });
  memoryAuth.resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  vi.stubGlobal("location", { assign: vi.fn(), origin: "http://app.test" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.turnstile;
  delete window.madeoraTurnstileLoaded;
  resetTurnstileLoaderForTests();
  document.head.querySelectorAll("script").forEach((script) => {
    script.remove();
  });
  delete document.documentElement.dataset.theme;
});

/** The submit button is busy (focusable, ignoring clicks) while Turnstile has no token. */
function waitingForCheck(button: HTMLElement): boolean {
  return button.getAttribute("aria-busy") === "true";
}

async function fillSignIn() {
  renderWithIntl(<SignInForm next="/" />);
  await userEvent.type(screen.getByLabelText(/^Email address/), "ada@example.test");
  await userEvent.type(screen.getByLabelText(/^Password( \*)?$/), "a synthetic password");
}

describe("Turnstile on the auth forms", () => {
  it("adds nothing without a site key", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    await fillSignIn();
    expect(screen.queryByTestId("turnstile-check")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "ada@example.test",
      password: "a synthetic password",
      options: {},
    });
    expect(turnstile.api.render).not.toHaveBeenCalled();
  });

  it("renders the widget with the site key, form action, language and page theme", async () => {
    document.documentElement.dataset.theme = "dark";
    renderWithIntl(<SignUpForm />, "nl");
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalledTimes(1);
    });
    expect(turnstile.widget()).toMatchObject({
      sitekey: siteKey,
      action: "sign-up",
      language: "nl",
      theme: "dark",
      "refresh-expired": "auto",
    });
  });

  it("follows the device theme when the page has none", async () => {
    renderWithIntl(<ForgotPasswordForm />);
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    expect(turnstile.widget().theme).toBe("auto");
  });

  it("holds sign-in until Turnstile has a token, sends it, then asks for a new one", async () => {
    await fillSignIn();
    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    expect(waitingForCheck(submit)).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Running a quick security check");
    await userEvent.click(submit);
    expect(signInWithPassword).not.toHaveBeenCalled();

    turnstile.solve("token-1");
    expect(waitingForCheck(submit)).toBe(false);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await userEvent.click(submit);

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "ada@example.test",
      password: "a synthetic password",
      options: { captchaToken: "token-1" },
    });
    // Tokens are single-use: the widget is reset after every attempt.
    expect(turnstile.api.reset).toHaveBeenCalledWith("widget-1");
  });

  it("disables the form again when the token expires", async () => {
    await fillSignIn();
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    turnstile.solve("token-1");
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(waitingForCheck(submit)).toBe(false);
    act(() => {
      turnstile.widget()["expired-callback"]?.();
    });
    expect(waitingForCheck(submit)).toBe(true);
  });

  it("needs a fresh token after a failed sign-in", async () => {
    signInWithPassword.mockResolvedValueOnce({
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    });
    await fillSignIn();
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    turnstile.solve("token-1");
    const submit = screen.getByRole("button", { name: "Sign in" });
    await userEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("incorrect");
    expect(waitingForCheck(submit)).toBe(true);
    // The button stays focusable while it waits, so keyboard focus is not lost (no native disabled).
    expect(submit).toBeEnabled();
    expect(submit).toHaveFocus();
  });

  it("explains a refused security check", async () => {
    signInWithPassword.mockResolvedValueOnce({
      error: new AuthApiError("captcha protection: request disallowed", 400, "captcha_failed"),
    });
    await fillSignIn();
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    turnstile.solve("token-1");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The security check didn't go through.",
    );
  });

  it("says when Turnstile reports an error, and clears it once a token arrives", async () => {
    await fillSignIn();
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    let handled: boolean | undefined;
    act(() => {
      handled = turnstile.widget()["error-callback"]?.("300030");
    });
    expect(handled).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("The security check couldn't load.");
    turnstile.solve("token-2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("removes the widget when the form goes away", async () => {
    const view = renderWithIntl(<SignInForm next="/" />);
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    view.unmount();
    expect(turnstile.api.remove).toHaveBeenCalledWith("widget-1");
  });

  it("sends the token with a sign-up and tells a visitor when sign-up is closed", async () => {
    memoryAuth.signUp.mockResolvedValueOnce({
      error: new AuthApiError("Signups not allowed for this instance", 422, "signup_disabled"),
    });
    renderWithIntl(<SignUpForm />);
    await userEvent.type(screen.getByLabelText(/^Email address/), "new@example.test");
    await userEvent.type(screen.getByLabelText(/^Password/), "a synthetic password");
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    turnstile.solve("token-1");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(memoryAuth.signUp).toHaveBeenCalledWith({
      email: "new@example.test",
      password: "a synthetic password",
      options: { emailRedirectTo: "http://app.test/auth/confirm", captchaToken: "token-1" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "New accounts can't be created here yet.",
    );
  });

  it("sends the token with a reset request and shows a refused check instead of 'sent'", async () => {
    memoryAuth.resetPasswordForEmail.mockResolvedValueOnce({
      error: new AuthApiError("captcha protection: request disallowed", 400, "captcha_failed"),
    });
    renderWithIntl(<ForgotPasswordForm />);
    await userEvent.type(screen.getByLabelText(/^Email address/), "ada@example.test");
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    turnstile.solve("token-1");
    await userEvent.click(screen.getByRole("button", { name: /reset link/i }));

    expect(memoryAuth.resetPasswordForEmail).toHaveBeenCalledWith("ada@example.test", {
      redirectTo: "http://app.test/auth/confirm",
      captchaToken: "token-1",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The security check didn't go through.",
    );
  });

  it("sends the token with a resend", async () => {
    renderWithIntl(<ResendConfirmation email="ada@example.test" />);
    await waitFor(() => {
      expect(turnstile.api.render).toHaveBeenCalled();
    });
    turnstile.solve("token-1");
    await userEvent.click(screen.getByRole("button", { name: "Send the email again" }));
    expect(memoryAuth.resend).toHaveBeenCalledWith({
      type: "signup",
      email: "ada@example.test",
      options: { emailRedirectTo: "http://app.test/auth/confirm", captchaToken: "token-1" },
    });
    expect(turnstile.widget().action).toBe("resend-confirmation");
  });
});

describe("loadTurnstile", () => {
  beforeEach(() => {
    delete window.turnstile;
  });

  it("adds the script once and resolves when Turnstile calls back", async () => {
    const first = loadTurnstile();
    const second = loadTurnstile();
    const scripts = document.head.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
    expect(scripts).toHaveLength(1);

    window.turnstile = turnstile.api;
    window.madeoraTurnstileLoaded?.();
    await expect(first).resolves.toBe(turnstile.api);
    await expect(second).resolves.toBe(turnstile.api);
  });

  it("rejects when the script fails, and lets a later call try again", async () => {
    const attempt = loadTurnstile();
    document.head.querySelector("script")?.dispatchEvent(new Event("error"));
    await expect(attempt).rejects.toThrow("failed to load");
    expect(document.head.querySelector("script")).toBeNull();

    void loadTurnstile().catch(() => undefined);
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });

  it("tells the form when the script cannot load", async () => {
    renderWithIntl(<SignInForm next="/" />);
    await waitFor(() => {
      expect(document.head.querySelector("script")).not.toBeNull();
    });
    document.head.querySelector("script")?.dispatchEvent(new Event("error"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The security check couldn't load.");
    expect(waitingForCheck(screen.getByRole("button", { name: "Sign in" }))).toBe(true);
  });
});
