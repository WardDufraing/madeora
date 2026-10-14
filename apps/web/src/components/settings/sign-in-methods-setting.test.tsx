import { AuthApiError } from "@supabase/supabase-js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LINK_STARTED_BY_KEY, type SignInMethodsView } from "@/auth/sign-in-methods";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { SignInMethodsSetting } from "./sign-in-methods-setting";

const reauth = {
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
};
const main = {
  linkIdentity: vi.fn(),
  getUserIdentities: vi.fn(),
  unlinkIdentity: vi.fn(),
};
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({ auth: main }),
  getMemoryOnlySupabaseClient: (purpose: string) => {
    if (purpose !== "reauthentication") throw new Error(`unexpected purpose ${purpose}`);
    return {
      auth: { signInWithPassword: reauth.signInWithPassword, signOut: reauth.signOut },
      rpc: reauth.rpc,
    };
  },
}));

const passwordOnly: SignInMethodsView = { email: "ada@example.test", password: true, google: null };
const both: SignInMethodsView = { ...passwordOnly, google: { email: "ada@gmail.test" } };
const googleOnly: SignInMethodsView = {
  email: "g@gmail.test",
  password: false,
  google: { email: "g@gmail.test" },
};

const assign = vi.fn();

beforeEach(() => {
  for (const fn of [...Object.values(reauth), ...Object.values(main), assign]) fn.mockReset();
  reauth.signInWithPassword.mockResolvedValue({ error: null });
  reauth.signOut.mockResolvedValue({ error: null });
  reauth.rpc.mockResolvedValue({ data: "2026-10-14T12:10:00Z", error: null });
  main.linkIdentity.mockResolvedValue({ data: { url: "https://google.test" }, error: null });
  vi.stubGlobal("location", { origin: "http://localhost", assign });
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function confirmWith(password: string, button: string, label = /^Your current password/) {
  await userEvent.type(screen.getByLabelText(label), password);
  await userEvent.click(screen.getByRole("button", { name: button }));
}

describe("SignInMethodsSetting", () => {
  it("links Google only after a separate password sign-in and a database permission", async () => {
    const { container } = renderWithIntl(
      <SignInMethodsSetting userId="user-1" methods={passwordOnly} googleAvailable notice={null} />,
    );
    expect(screen.getByText("Not linked.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Link Google" }));
    expect(
      screen.getByText(/Google will be linked to your Madeora account ada@example.test/),
    ).toBeVisible();
    expect(screen.getByLabelText(/^Your current password/)).toHaveFocus();
    expect(await axeViolations(container)).toEqual([]);

    await confirmWith("correct horse battery", "Confirm and go to Google");
    expect(reauth.signInWithPassword).toHaveBeenCalledWith({
      email: "ada@example.test",
      password: "correct horse battery",
      options: {},
    });
    expect(reauth.rpc).toHaveBeenCalledWith("authorize_sign_in_method_change", {
      p_action: "link",
      p_provider: "google",
    });
    // The extra session is ended locally; the browser's own session is never touched.
    expect(reauth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(main.linkIdentity).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "http://localhost/auth/callback?flow=link",
        queryParams: { prompt: "select_account" },
      },
    });
    expect(window.sessionStorage.getItem(LINK_STARTED_BY_KEY)).toBe("user-1");
  });

  it("stops at a wrong password, in Dutch too", async () => {
    reauth.signInWithPassword.mockResolvedValue({
      error: new AuthApiError("x", 400, "invalid_credentials"),
    });
    renderWithIntl(
      <SignInMethodsSetting userId="user-1" methods={passwordOnly} googleAvailable notice={null} />,
      "nl",
    );
    await userEvent.click(screen.getByRole("button", { name: "Google koppelen" }));
    await confirmWith("wrong", "Bevestigen en naar Google", /^Je huidige wachtwoord/);
    expect(await screen.findByRole("alert")).toHaveTextContent("Dat wachtwoord klopt niet.");
    expect(reauth.rpc).not.toHaveBeenCalled();
    expect(main.linkIdentity).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Je huidige wachtwoord/)).toHaveValue("");
  });

  it("explains a refused permission and still ends the extra session", async () => {
    reauth.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", hint: "reauthentication_required", message: "x" },
    });
    renderWithIntl(
      <SignInMethodsSetting userId="user-1" methods={passwordOnly} googleAvailable notice={null} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Link Google" }));
    await confirmWith("correct horse battery", "Confirm and go to Google");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please confirm your password again.",
    );
    expect(reauth.signOut).toHaveBeenCalled();
    expect(main.linkIdentity).not.toHaveBeenCalled();
  });

  it("unlinks Google after the password and reloads with a notice", async () => {
    main.getUserIdentities.mockResolvedValue({
      data: { identities: [{ provider: "email" }, { provider: "google", identity_id: "g-1" }] },
      error: null,
    });
    main.unlinkIdentity.mockResolvedValue({ data: {}, error: null });
    renderWithIntl(
      <SignInMethodsSetting userId="user-1" methods={both} googleAvailable notice={null} />,
    );
    expect(screen.getByText("Linked to the Google account ada@gmail.test.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Unlink Google" }));
    await confirmWith("correct horse battery", "Unlink Google");
    expect(reauth.rpc).toHaveBeenCalledWith("authorize_sign_in_method_change", {
      p_action: "unlink",
      p_provider: "google",
    });
    expect(main.unlinkIdentity).toHaveBeenCalledWith({ provider: "google", identity_id: "g-1" });
    expect(assign).toHaveBeenCalledWith(
      new URL("http://localhost/settings?unlinked=google#sign-in-methods"),
    );
  });

  it("shows when the database refuses the unlink", async () => {
    main.getUserIdentities.mockResolvedValue({
      data: { identities: [{ provider: "google", identity_id: "g-1" }] },
      error: null,
    });
    main.unlinkIdentity.mockResolvedValue({
      data: null,
      error: new AuthApiError("Database error deleting identity", 500, "unexpected_failure"),
    });
    renderWithIntl(
      <SignInMethodsSetting userId="user-1" methods={both} googleAvailable notice={null} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Unlink Google" }));
    await confirmWith("correct horse battery", "Unlink Google");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This change isn't allowed, so your sign-in methods were not changed.",
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("offers no unlink when Google is the only way to sign in", () => {
    renderWithIntl(
      <SignInMethodsSetting userId="user-1" methods={googleOnly} googleAvailable notice={null} />,
    );
    expect(screen.getByText("No password yet.")).toBeVisible();
    expect(screen.getByText(/Google is your only way to sign in/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Unlink Google" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link Google" })).toBeNull();
  });

  it("offers no link while Google sign-in is switched off", () => {
    renderWithIntl(
      <SignInMethodsSetting
        userId="user-1"
        methods={passwordOnly}
        googleAvailable={false}
        notice={null}
      />,
    );
    expect(screen.getByText("Google sign-in isn't switched on here yet.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Link Google" })).toBeNull();
  });

  it("confirms a finished link or unlink, and cancelling closes the form", async () => {
    const { unmount } = renderWithIntl(
      <SignInMethodsSetting userId="user-1" methods={both} googleAvailable notice="linked" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Google is linked.");
    unmount();
    renderWithIntl(
      <SignInMethodsSetting
        userId="user-1"
        methods={passwordOnly}
        googleAvailable
        notice="unlinked"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Google is unlinked.");
    await userEvent.click(screen.getByRole("button", { name: "Link Google" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/^Your current password/)).toBeNull();
    expect(screen.getByRole("button", { name: "Link Google" })).toBeVisible();
  });
});
