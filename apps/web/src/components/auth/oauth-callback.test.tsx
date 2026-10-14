import { AuthApiError } from "@supabase/supabase-js";
import { screen, waitFor } from "@testing-library/react";

import { LINK_STARTED_BY_KEY } from "@/auth/sign-in-methods";
import { renderWithIntl } from "@/test/intl";

import { OAuthCallback } from "./oauth-callback";

const auth = { exchangeCodeForSession: vi.fn(), getUser: vi.fn() };
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({ auth }),
}));

const assign = vi.fn();

const replaceState = vi.spyOn(window.history, "replaceState");

function openCallback(query: string) {
  vi.stubGlobal("location", {
    origin: "http://app.test",
    pathname: "/auth/callback",
    search: query,
    assign,
  });
}

beforeEach(() => {
  auth.exchangeCodeForSession.mockReset();
  auth.getUser.mockReset();
  assign.mockReset();
  replaceState.mockClear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuthCallback", () => {
  it("exchanges the code once, clears it from the address and opens the requested page", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
    openCallback("?code=one-time&next=%2Fsettings");
    renderWithIntl(<OAuthCallback />);
    expect(screen.getByRole("status")).toHaveTextContent("Finishing with Google…");
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(new URL("http://app.test/settings"));
    });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("one-time");
    // The one-time code leaves the address bar at once.
    expect(replaceState).toHaveBeenCalledWith(window.history.state, "", "/auth/callback");
  });

  it("never follows an off-site next address", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
    openCallback("?code=one-time&next=%2F%2Fevil.example");
    renderWithIntl(<OAuthCallback />);
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(new URL("http://app.test/"));
    });
  });

  it.each([
    ["?error=access_denied&error_description=denied", "Signing in with Google was cancelled."],
    ["?error=server_error&error_description=Database+error", "Signing in with Google didn't work."],
    ["?error=access_denied&error_code=signup_disabled", "New accounts can't be created here yet."],
    ["?error=invalid_request&error_code=bad_oauth_state", "This Google sign-in has expired"],
  ])("%s explains itself without a code exchange", async (query, message) => {
    openCallback(query);
    renderWithIntl(<OAuthCallback />);
    expect(await screen.findByText(new RegExp(message.replace(/[.?]/g, "\\$&")))).toBeVisible();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute(
      "href",
      "/sign-in",
    );
  });

  it("reports a code that can no longer be used", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({
      data: {},
      error: new AuthApiError("x", 404, "flow_state_not_found"),
    });
    openCallback("?code=used");
    renderWithIntl(<OAuthCallback />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This Google sign-in has expired");
  });

  it("finishes a link for the account that started it, without swapping sessions", async () => {
    window.sessionStorage.setItem(LINK_STARTED_BY_KEY, "user-1");
    auth.getUser.mockResolvedValue({
      data: { user: { id: "user-1", identities: [{ provider: "email" }, { provider: "google" }] } },
      error: null,
    });
    openCallback("?flow=link&code=unused");
    renderWithIntl(<OAuthCallback />);
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        new URL("http://app.test/settings?linked=google#sign-in-methods"),
      );
    });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(LINK_STARTED_BY_KEY)).toBeNull();
  });

  it("says so when the browser is now signed in to another account, in Dutch too", async () => {
    window.sessionStorage.setItem(LINK_STARTED_BY_KEY, "user-1");
    auth.getUser.mockResolvedValue({
      data: { user: { id: "user-2", identities: [{ provider: "email" }] } },
      error: null,
    });
    openCallback("?flow=link&code=unused");
    renderWithIntl(<OAuthCallback />, "nl");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Deze browser is nu aangemeld bij een ander account",
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("explains a refused link", async () => {
    window.sessionStorage.setItem(LINK_STARTED_BY_KEY, "user-1");
    openCallback("?flow=link&error=invalid_request&error_code=identity_already_exists");
    renderWithIntl(<OAuthCallback />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Google account can't be linked.",
    );
    expect(screen.getByRole("link", { name: "Back to settings" })).toHaveAttribute(
      "href",
      "/settings#sign-in-methods",
    );
  });
});
