import { AuthApiError } from "@supabase/supabase-js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithIntl } from "@/test/intl";

import { GoogleSignIn, googleCallbackUrl } from "./google-sign-in";

const signInWithOAuth = vi.fn();
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({ auth: { signInWithOAuth } }),
}));

beforeEach(() => {
  signInWithOAuth.mockReset();
});

describe("googleCallbackUrl", () => {
  it("returns to the callback page, carrying only a non-default destination", () => {
    expect(googleCallbackUrl("http://app.test", "/")).toBe("http://app.test/auth/callback");
    expect(googleCallbackUrl("http://app.test", "/tasks?x=1")).toBe(
      "http://app.test/auth/callback?next=%2Ftasks%3Fx%3D1",
    );
  });
});

describe("GoogleSignIn", () => {
  it("sends the browser to Google with an account chooser", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: "https://google.test" }, error: null });
    renderWithIntl(<GoogleSignIn next="/settings" />);
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "http://localhost:3000/auth/callback?next=%2Fsettings",
        queryParams: { prompt: "select_account" },
      },
    });
  });

  it("explains a failure to start, in Dutch too", async () => {
    signInWithOAuth.mockResolvedValue({
      data: {},
      error: new AuthApiError("x", 429, "over_request_rate_limit"),
    });
    renderWithIntl(<GoogleSignIn next="/" />, "nl");
    await userEvent.click(screen.getByRole("button", { name: "Doorgaan met Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Te veel pogingen.");
    expect(screen.getByRole("button", { name: "Doorgaan met Google" })).toBeEnabled();
  });
});
